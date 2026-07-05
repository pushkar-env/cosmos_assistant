import { useEffect, useState } from 'react'
import type { GpuInfo } from '@shared/types'
import { useSystemStore } from '@/core/stores/useSystemStore'
import { BigValue, MeterBar, StatCard, SubValue } from './StatCard'

/** One GPU's live status — name, load bar (or temp/VRAM when load is N/A). */
function GpuRow({ gpu }: { gpu: GpuInfo }): React.JSX.Element {
  const meta = [
    gpu.temp != null ? `${gpu.temp}°C` : null,
    gpu.vramTotal
      ? `${(((gpu.vramUsed ?? 0) / gpu.vramTotal) * 100).toFixed(0)}% VRAM`
      : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-ui text-xs font-semibold text-body">
          {gpu.vendor && <span className="text-dim">{gpu.vendor} </span>}
          {gpu.model.replace(new RegExp(`^${gpu.vendor}\\s*`, 'i'), '')}
        </span>
        <span className="tabular shrink-0 font-mono text-sm font-semibold text-body">
          {gpu.load != null ? `${gpu.load.toFixed(0)}%` : '—'}
        </span>
      </div>
      {gpu.load != null ? (
        <MeterBar value={gpu.load} danger={gpu.load > 95} />
      ) : (
        <div className="mt-1 h-1 w-full rounded-full bg-white/5" />
      )}
      {meta && <div className="tabular mt-1 font-mono text-[10px] text-dim">{meta}</div>}
    </div>
  )
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`
}

function formatRate(bytesPerSec: number): string {
  const mbps = (bytesPerSec * 8) / 1_000_000
  if (mbps >= 1) return `${mbps.toFixed(1)} Mbps`
  return `${((bytesPerSec * 8) / 1000).toFixed(0)} Kbps`
}

function Clock(): React.JSX.Element {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <>
      <BigValue>
        {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
      </BigValue>
      <SubValue>
        {now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}
      </SubValue>
    </>
  )
}

/** Left column of live holographic telemetry. Cards are draggable. */
export function HudLayer(): React.JSX.Element {
  const stats = useSystemStore((s) => s.stats)
  const weather = useSystemStore((s) => s.weather)

  const cpuLoad = stats?.cpu.load ?? 0
  const memPct = stats ? (stats.mem.used / stats.mem.total) * 100 : 0

  return (
    <div className="pointer-events-none absolute inset-y-0 left-0 z-20 flex flex-col justify-center gap-4 pl-6">
      <div className="pointer-events-auto flex flex-col gap-4">
        <StatCard title="CPU" delay={0.05}>
          <BigValue>{cpuLoad.toFixed(1)}%</BigValue>
          <SubValue>
            {stats?.cpu.cores ?? '—'} cores
            {stats?.cpu.temp != null ? ` · ${stats.cpu.temp}°C` : ''}
          </SubValue>
          <MeterBar value={cpuLoad} danger={cpuLoad > 90} />
        </StatCard>

        <StatCard title="GPU" delay={0.12}>
          {!stats || stats.gpus.length === 0 ? (
            <SubValue>detecting…</SubValue>
          ) : (
            <div className="flex flex-col gap-2.5">
              {stats.gpus.map((gpu, i) => (
                <GpuRow key={`${gpu.model}-${i}`} gpu={gpu} />
              ))}
            </div>
          )}
        </StatCard>

        <StatCard title="Memory" delay={0.19}>
          <BigValue>{stats ? formatBytes(stats.mem.used) : '—'}</BigValue>
          <SubValue>of {stats ? formatBytes(stats.mem.total) : '—'}</SubValue>
          <MeterBar value={memPct} danger={memPct > 92} />
        </StatCard>

        <StatCard title="Network" delay={0.26}>
          <BigValue>{stats ? formatRate(stats.net.rxSec) : '—'}</BigValue>
          <SubValue>↑ {stats ? formatRate(stats.net.txSec) : '—'}</SubValue>
        </StatCard>

        <StatCard title="Clock" delay={0.33}>
          <Clock />
        </StatCard>

        {weather && (
          <StatCard title="Weather" delay={0.4}>
            <BigValue>{Math.round(weather.tempC)}°C</BigValue>
            <SubValue>
              {weather.description} · {weather.location}
            </SubValue>
          </StatCard>
        )}

        {stats?.battery.hasBattery && (
          <StatCard title="Battery" delay={0.47}>
            <BigValue>
              {stats.battery.percent}%{stats.battery.isCharging ? ' ⚡' : ''}
            </BigValue>
            <MeterBar value={stats.battery.percent} danger={stats.battery.percent < 15} />
          </StatCard>
        )}
      </div>
    </div>
  )
}
