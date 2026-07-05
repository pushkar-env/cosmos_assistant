import si from 'systeminformation'
import { execFile } from 'child_process'
import type { BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import type { GpuInfo, SystemStats } from '@shared/types'

const POLL_MS = 2000

interface NvidiaStat {
  name: string
  load: number | null
  temp: number | null
  memUsed: number | null
  memTotal: number | null
}

/**
 * Polls hardware telemetry in the main process and pushes it to the
 * renderer. The renderer never polls — one timer, one IPC push.
 */
export class SystemStatsService {
  private timer: NodeJS.Timeout | null = null
  private cpuBrand = ''
  private hasNvidiaSmi = true

  async start(getWindow: () => BrowserWindow | null): Promise<void> {
    try {
      const cpu = await si.cpu()
      this.cpuBrand = `${cpu.manufacturer} ${cpu.brand}`.trim()
    } catch {
      /* metadata is cosmetic; live polling still works */
    }

    const tick = async (): Promise<void> => {
      const win = getWindow()
      if (!win || win.isDestroyed()) return
      try {
        const stats = await this.collect()
        win.webContents.send(IPC.SYSTEM_STATS, stats)
      } catch (err) {
        console.error('[stats] poll failed:', err)
      }
    }

    this.timer = setInterval(tick, POLL_MS)
    void tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** one-shot telemetry snapshot (used by the system_stats tool) */
  snapshot(): Promise<SystemStats> {
    return this.collect()
  }

  private async collect(): Promise<SystemStats> {
    const [load, mem, temp, gfx, net, battery, time, nvidia] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.cpuTemperature(),
      si.graphics(),
      si.networkStats(),
      si.battery(),
      Promise.resolve(si.time()),
      this.queryNvidia()
    ])

    const primaryNet = net[0]

    return {
      cpu: {
        load: round(load.currentLoad),
        temp: temp.main && temp.main > 0 ? round(temp.main) : null,
        cores: load.cpus.length,
        brand: this.cpuBrand
      },
      gpus: this.buildGpus(gfx.controllers, nvidia),
      mem: { used: mem.active, total: mem.total },
      net: {
        rxSec: primaryNet?.rx_sec ?? 0,
        txSec: primaryNet?.tx_sec ?? 0
      },
      battery: {
        hasBattery: battery.hasBattery,
        percent: battery.percent,
        isCharging: battery.isCharging
      },
      uptime: Number(time.uptime)
    }
  }

  /**
   * Merge every detected GPU with live nvidia-smi data. systeminformation
   * lists all controllers (integrated AMD, discrete NVIDIA…) but usually
   * reports no utilization on Windows; nvidia-smi fills in real load /
   * temp / VRAM for NVIDIA cards, matched by name.
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
