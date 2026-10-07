import si from 'systeminformation'
import { execFile } from 'child_process'
import type { BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import type { GpuInfo, SystemStats } from '@shared/types'

/** live gauges — CPU load + package temp, RAM, network, GPU utilisation */
const FAST_MS = 2000
/**
 * Near-static facts: the GPU inventory (model / VRAM size) and the battery.
 * Measured on Windows these two are ~295ms of the ~440ms a full poll costs,
 * against ~145ms for everything on the fast tier — and neither moves on a
 * two-second timescale (a battery percentage shifts over minutes, an installed
 * GPU never). They refresh on their own cadence and are cached in between.
 * Live NVIDIA load/temp/VRAM does NOT come from here — nvidia-smi is cheap and
 * stays on the fast tier — so the GPU card keeps updating every 2s.
 */
const SLOW_MS = 30_000
/** a wedged PowerShell host must never stall the poller forever */
const COLLECT_TIMEOUT_MS = 15_000

const isWindows = process.platform === 'win32'

interface NvidiaStat {
  name: string
  load: number | null
  temp: number | null
  memUsed: number | null
  memTotal: number | null
}

/** the slow tier's cached readings, merged into every push */
interface SlowStats {
  controllers: si.Systeminformation.GraphicsControllerData[]
  battery: { hasBattery: boolean; percent: number; isCharging: boolean }
}

/**
 * Polls hardware telemetry in the main process and pushes it to the
 * renderer. The renderer never polls — one timer, one IPC push.
 *
 * Cost discipline matters here more than it looks. On Windows every
 * systeminformation call that reaches WMI/CIM shells out to PowerShell, and by
 * default that means a COLD `powershell.exe` per query — `si.graphics()` alone
 * is seven of them. Three things keep this cheap:
 *
 *  1. one persistent PowerShell host (`powerShellStart`) that every query is
 *     piped through, instead of ~12 process launches per poll;
 *  2. a self-scheduling loop rather than setInterval, so a slow poll can never
 *     overlap the next one and pile queries up without bound;
 *  3. the fast/slow split above — the expensive WMI reads run at 1/15th the
 *     rate of the cheap ones.
 */
export class SystemStatsService {
  private timer: NodeJS.Timeout | null = null
  private getWindow: (() => BrowserWindow | null) | null = null
  private running = false
  private paused = false
  private cpuBrand = ''
  private hasNvidiaSmi = true
  private slow: SlowStats = {
    controllers: [],
    battery: { hasBattery: false, percent: 0, isCharging: false }
  }
  private slowAt = 0

  async start(getWindow: () => BrowserWindow | null): Promise<void> {
    if (this.running) return
    this.running = true
    this.paused = false
    this.getWindow = getWindow

    // Route every WMI/CIM query through one long-lived PowerShell process.
    // Without this each query cold-starts its own powershell.exe (~300ms of a
    // full core just to boot the shell), which is what pegged the CPU.
    if (isWindows) si.powerShellStart()

    try {
      const cpu = await si.cpu()
      this.cpuBrand = `${cpu.manufacturer} ${cpu.brand}`.trim()
    } catch {
      /* metadata is cosmetic; live polling still works */
    }

    void this.tick()
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (isWindows) si.powerShellRelease()
  }

  /**
   * Stop polling while nothing can see the readout (hidden to tray, or
   * minimised). Voice and audio live in the renderer and are unaffected.
   * The PowerShell host goes too — ~95 MB, idling for nobody for as long as
   * COSMOS sits in the tray (a query already sent still finishes: `exit`
   * queues behind it).
   */
  pause(): void {
    if (this.paused) return
    this.paused = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (isWindows && this.running) si.powerShellRelease()
  }

  /** Resume polling, with an immediate refresh so the HUD is never stale. */
  resume(): void {
    if (!this.paused) return
    this.paused = false
    if (isWindows && this.running) si.powerShellStart()
    if (this.running && !this.timer) void this.tick()
  }

  /** one-shot telemetry snapshot (used by the system_stats tool) */
  snapshot(): Promise<SystemStats> {
    return this.collect(true) // the tool gets everything fresh, slow tier included
  }

  private async tick(): Promise<void> {
    this.timer = null
    if (!this.running || this.paused) return

    const win = this.getWindow?.()
    if (win && !win.isDestroyed()) {
      try {
        const stats = await this.withTimeout(this.collect())
        if (!win.isDestroyed()) win.webContents.send(IPC.SYSTEM_STATS, stats)
      } catch (err) {
        console.error('[stats] poll failed:', err)
        // A timeout means the shared PowerShell host stopped answering; its
        // pending queries never resolve, so replace it before the next tick.
        if (isWindows && !this.paused && err instanceof Error && err.message === 'stats-timeout') {
          si.powerShellRelease()
          si.powerShellStart()
        }
      }
    }

    if (this.running && !this.paused) this.timer = setTimeout(() => void this.tick(), FAST_MS)
  }

  private withTimeout<T>(work: Promise<T>): Promise<T> {
    let handle: NodeJS.Timeout | undefined
    const guard = new Promise<never>((_, reject) => {
      handle = setTimeout(() => reject(new Error('stats-timeout')), COLLECT_TIMEOUT_MS)
    })
    return Promise.race([work, guard]).finally(() => clearTimeout(handle))
  }

  private async collect(force = false): Promise<SystemStats> {
    const slowDue = force || Date.now() - this.slowAt >= SLOW_MS

    const [load, mem, net, temp, nvidia] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.networkStats(),
      si.cpuTemperature(),
      this.queryNvidia(),
      slowDue ? this.refreshSlow() : Promise.resolve()
    ])

    const primaryNet = net[0]
    const time = si.time()

    return {
      cpu: {
        load: round(load.currentLoad),
        temp: temp.main && temp.main > 0 ? round(temp.main) : null,
        cores: load.cpus.length,
        brand: this.cpuBrand
      },
      gpus: this.buildGpus(this.slow.controllers, nvidia),
      mem: { used: mem.active, total: mem.total },
      net: {
        rxSec: primaryNet?.rx_sec ?? 0,
        txSec: primaryNet?.tx_sec ?? 0
      },
      battery: this.slow.battery,
      uptime: Number(time.uptime)
    }
  }

  /**
   * Refresh the expensive tier. A failure keeps the previous reading rather
   * than blanking the HUD, and still stamps the clock so a broken sensor can't
   * turn into a retry storm.
   */
  private async refreshSlow(): Promise<void> {
    try {
      const [gfx, battery] = await Promise.all([si.graphics(), si.battery()])
      this.slow = {
        controllers: gfx.controllers,
        battery: {
          hasBattery: battery.hasBattery,
          percent: battery.percent,
          isCharging: battery.isCharging
        }
      }
    } catch (err) {
      console.error('[stats] slow tier failed (keeping last reading):', err)
    } finally {
      this.slowAt = Date.now()
    }
  }

  /**
   * Merge every detected GPU with live nvidia-smi data. systeminformation
   * lists all controllers (integrated AMD, discrete NVIDIA…) but usually
   * reports no utilization on Windows; nvidia-smi fills in real load /
   * temp / VRAM for NVIDIA cards, matched by name. nvidia-smi is cheap and
   * stays on the fast tier, so NVIDIA load/temp/VRAM still update every 2s.
   */
  private buildGpus(
    controllers: si.Systeminformation.GraphicsControllerData[],
    nvidia: NvidiaStat[]
  ): GpuInfo[] {
    const usedNvidia = new Set<number>()
    const gpus = controllers
      // drop virtual/basic display adapters
      .filter((c) => c.model && !/microsoft basic|remote|virtual/i.test(c.model))
      .map((c): GpuInfo => {
        let load = c.utilizationGpu ?? null
        let temp = c.temperatureGpu ?? null
        let vramUsed = c.memoryUsed ?? null
        let vramTotal = c.memoryTotal ?? (c.vram ? c.vram : null)

        if (/nvidia/i.test(`${c.vendor} ${c.model}`)) {
          const i = nvidia.findIndex((n, idx) => !usedNvidia.has(idx) && namesMatch(n.name, c.model))
          const n = i >= 0 ? (usedNvidia.add(i), nvidia[i]) : undefined
          if (n) {
            load = n.load ?? load
            temp = n.temp ?? temp
            vramUsed = n.memUsed ?? vramUsed
            vramTotal = n.memTotal ?? vramTotal
          }
        }
        return {
          model: cleanModel(c.model),
          vendor: shortVendor(c.vendor),
          load,
          temp,
          vramUsed,
          vramTotal
        }
      })
    return gpus.length ? gpus : [{ model: 'GPU', vendor: '', load: null, temp: null, vramUsed: null, vramTotal: null }]
  }

  private queryNvidia(): Promise<NvidiaStat[]> {
    if (!this.hasNvidiaSmi) return Promise.resolve([])
    return new Promise((resolve) => {
      execFile(
        'nvidia-smi',
        [
          '--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total',
          '--format=csv,noheader,nounits'
        ],
        { windowsHide: true, timeout: 4000 },
        (err, stdout) => {
          if (err) {
            this.hasNvidiaSmi = false // no NVIDIA driver / tool — stop trying
            return resolve([])
          }
          const rows = stdout
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => {
              const [name, util, t, used, total] = line.split(',').map((s) => s.trim())
              return {
                name,
                load: num(util),
                temp: num(t),
                memUsed: num(used),
                memTotal: num(total)
              }
            })
          resolve(rows)
        }
      )
    })
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}

function num(s: string | undefined): number | null {
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function namesMatch(a: string, b: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/nvidia|geforce|\(r\)|\(tm\)|\s+/g, '')
  return norm(a) === norm(b) || norm(a).includes(norm(b)) || norm(b).includes(norm(a))
}

function cleanModel(m: string): string {
  return m.replace(/\(R\)|\(TM\)|Corporation|Advanced Micro Devices, Inc\./gi, '').replace(/\s+/g, ' ').trim()
}

function shortVendor(v: string): string {
  if (/nvidia/i.test(v)) return 'NVIDIA'
  if (/amd|advanced micro/i.test(v)) return 'AMD'
  if (/intel/i.test(v)) return 'Intel'
  return v.split(' ')[0] ?? ''
}
