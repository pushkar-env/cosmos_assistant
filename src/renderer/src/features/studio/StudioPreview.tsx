import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStudioStore } from './useStudioStore'
import type { WebviewEl } from './webview'

/** normalize a typed address into a loadable URL (default http, localhost bare ports) */
function normalizeUrl(raw: string): string {
  const v = raw.trim()
  if (!v) return ''
  if (/^https?:\/\//i.test(v)) return v
  if (/^\d+$/.test(v)) return `http://localhost:${v}` // "3000" → localhost:3000
  if (/^localhost(:\d+)?/i.test(v) || /^127\.0\.0\.1(:\d+)?/.test(v)) return `http://${v}`
  return `http://${v}`
}

// ── Viewport presets ────────────────────────────────────────────────────────
// Each device gives the guest page a *logical* CSS width/height. The page lays
// itself out for that width (its own media queries fire correctly), then we
// visually scale the whole webview with a CSS transform so it always fits the
// pane — a desktop site never overflows, a game always gets a clean stage.
type ViewportId = 'responsive' | 'desktop' | 'laptop' | 'tablet' | 'mobile'
interface Viewport {
  id: ViewportId
  label: string
  w: number
  h: number
}
const VIEWPORTS: Viewport[] = [
  { id: 'responsive', label: 'Responsive — fill the pane', w: 0, h: 0 },
  { id: 'desktop', label: 'Desktop — 1440 × 900', w: 1440, h: 900 },
  { id: 'laptop', label: 'Laptop — 1280 × 800', w: 1280, h: 800 },
  { id: 'tablet', label: 'Tablet — 820 × 1180', w: 820, h: 1180 },
  { id: 'mobile', label: 'Mobile — 390 × 844', w: 390, h: 844 }
]

type Zoom = 'fit' | number
const ZOOMS: Zoom[] = ['fit', 0.5, 0.75, 1, 1.25, 1.5]

// ── Preview UI prefs (remembered across sessions) ────────────────────────────
const PREFS_KEY = 'cosmos.studio.preview.prefs'
interface Prefs {
  viewport: ViewportId
  zoom: Zoom
  rotated: boolean
}
function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<Prefs>
      const viewport = VIEWPORTS.some((v) => v.id === p.viewport)
        ? (p.viewport as ViewportId)
        : 'responsive'
      const zoom = p.zoom === 'fit' || typeof p.zoom === 'number' ? p.zoom : 'fit'
      return { viewport, zoom, rotated: !!p.rotated }
    }
  } catch {
    /* corrupt / unavailable */
  }
  return { viewport: 'responsive', zoom: 'fit', rotated: false }
}

/** small line-art device icons, kept monochrome to match the toolbar glyphs */
function DeviceIcon({ id }: { id: ViewportId }): React.JSX.Element {
  const p = {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  switch (id) {
    case 'responsive':
      return (
        <svg {...p}>
          <rect x="2.5" y="5" width="19" height="13" rx="1.6" />
          <path d="M7.5 11.5 5.5 13.5l2 2M16.5 11.5l2 2-2 2M9.5 15.5l5-4" />
        </svg>
      )
    case 'desktop':
    case 'laptop':
      return (
        <svg {...p}>
          <rect x="2.5" y="4" width="19" height="12.5" rx="1.4" />
          <path d="M8.5 20h7M12 16.5V20" />
        </svg>
      )
    case 'tablet':
      return (
        <svg {...p}>
          <rect x="5" y="2.5" width="14" height="19" rx="2" />
          <path d="M10.5 18.5h3" />
        </svg>
      )
    case 'mobile':
      return (
        <svg {...p}>
          <rect x="7" y="2" width="10" height="20" rx="2" />
          <path d="M10.5 18.5h3" />
        </svg>
      )
  }
}

/** expand / collapse (corners pointing out vs in) */
function ExpandIcon({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  const p = {
    width: 13,
    height: 13,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  return collapsed ? (
    <svg {...p}>
      <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5" />
    </svg>
  ) : (
    <svg {...p}>
      <path d="M3 8h5V3M21 8h-5V3M16 21v-5h5M3 16h5v5" />
    </svg>
  )
}

export function StudioPreview(): React.JSX.Element {
  const previewUrl = useStudioStore((s) => s.previewUrl)
  const setPreviewUrl = useStudioStore((s) => s.setPreviewUrl)
  const togglePanel = useStudioStore((s) => s.togglePanel)
  const view = useRef<WebviewEl | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [address, setAddress] = useState(previewUrl)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  // viewport / scaling state
  const initial = useRef(loadPrefs()).current
  const [viewport, setViewport] = useState<ViewportId>(initial.viewport)
  const [zoom, setZoom] = useState<Zoom>(initial.zoom)
  const [rotated, setRotated] = useState(initial.rotated)
  const [expanded, setExpanded] = useState(false)
  const [stage, setStage] = useState({ w: 0, h: 0 })

  const hasPreview = !!previewUrl
  const device = viewport !== 'responsive'
  const preset = VIEWPORTS.find((v) => v.id === viewport) ?? VIEWPORTS[0]
  const canRotate = viewport === 'tablet' || viewport === 'mobile'
  const [vw, vh] = rotated && canRotate ? [preset.h, preset.w] : [preset.w, preset.h]

  // fit = largest scale that keeps the whole device inside the stage
  const fit = device && vw && stage.w ? Math.min(stage.w / vw, stage.h / vh) : 1
  const scale = !device ? 1 : zoom === 'fit' ? Math.min(fit, 1) : zoom

  // keep the address bar in sync when the committed url changes elsewhere
  useEffect(() => setAddress(previewUrl), [previewUrl])

  // remember viewport prefs
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ viewport, zoom, rotated }))
    } catch {
      /* storage unavailable */
    }
  }, [viewport, zoom, rotated])

  // measure the stage so device modes can auto-fit; re-measures on pane resize
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = (): void => setStage({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasPreview, expanded])

  // wire webview lifecycle events → address bar + loading/error states.
  // re-runs when the webview mounts/unmounts (previewUrl gains/loses a value)
  useEffect(() => {
    const el = view.current
    if (!el) return
    el.setAttribute('allowpopups', 'true')
    const onStart = (): void => {
      setLoading(true)
      setFailed(null)
    }
    const onStop = (): void => setLoading(false)
    const onNav = (): void => {
      try {
        setAddress(el.getURL())
      } catch {
        /* view not ready */
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onFail = (e: any): void => {
      // -3 == aborted (e.g. superseded navigation) — not a real failure
      if (e?.errorCode && e.errorCode !== -3) setFailed(e.errorDescription || 'Failed to load')
      setLoading(false)
    }
    el.addEventListener('did-start-loading', onStart)
    el.addEventListener('did-stop-loading', onStop)
    el.addEventListener('did-navigate', onNav)
    el.addEventListener('did-navigate-in-page', onNav)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    el.addEventListener('did-fail-load', onFail as any)
    return () => {
      el.removeEventListener('did-start-loading', onStart)
      el.removeEventListener('did-stop-loading', onStop)
      el.removeEventListener('did-navigate', onNav)
      el.removeEventListener('did-navigate-in-page', onNav)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      el.removeEventListener('did-fail-load', onFail as any)
    }
  }, [hasPreview])

  // Esc leaves the expanded (fill-window) mode
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  const commit = (): void => {
    const url = normalizeUrl(address)
    if (!url) return
    setFailed(null)
    setPreviewUrl(url)
    // if the src is unchanged, force a reload so "go" always does something
    if (url === previewUrl) view.current?.reload()
  }

  const reload = (): void => {
    setFailed(null)
    view.current?.reload()
  }

  const pickViewport = (id: ViewportId): void => {
    setViewport(id)
    if (id === 'responsive' || id === 'desktop' || id === 'laptop') setRotated(false)
  }

  // Shared webview element — kept mounted across viewport changes so switching
  // devices (or rotating/zooming) never reloads the running page or game.
  const webviewStyle: React.CSSProperties = device
    ? {
        position: 'absolute',
        top: 0,
        left: 0,
        width: vw,
        height: vh,
        transform: `scale(${scale})`,
        transformOrigin: '0 0',
        display: 'block',
        border: 0,
        background: '#fff'
      }
    : {
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        display: 'block',
        border: 0,
        background: '#fff'
      }

  const frameStyle: React.CSSProperties = device
    ? {
        position: 'relative',
        margin: 'auto',
        flex: '0 0 auto',
        width: Math.max(1, Math.round(vw * scale)),
        height: Math.max(1, Math.round(vh * scale)),
        background: '#fff',
        overflow: 'hidden',
        borderRadius: viewport === 'mobile' || viewport === 'tablet' ? 18 : 8,
        boxShadow: '0 24px 70px -24px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.09)',
        transition: 'width 0.18s ease, height 0.18s ease'
      }
    : { position: 'relative', flex: '1 1 auto', width: '100%', height: '100%', background: '#fff' }

  const readout = device
    ? `${vw} × ${vh} · ${Math.round(scale * 100)}%`
    : stage.w
      ? `${Math.round(stage.w)} × ${Math.round(stage.h)}`
      : 'Responsive'

  return (
    <div
      className={`flex h-full flex-col border-l border-white/5 bg-black/20 ${
        expanded ? 'fixed inset-0 z-[60] border-l-0 bg-black' : ''
      }`}
    >
      {/* preview toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-white/5 px-2">
        <button
          onClick={() => view.current?.goBack()}
          title="Back"
          className="rounded px-1.5 font-mono text-xs text-dim hover:bg-white/5 hover:text-body"
        >
          ‹
        </button>
        <button
          onClick={() => view.current?.goForward()}
          title="Forward"
          className="rounded px-1.5 font-mono text-xs text-dim hover:bg-white/5 hover:text-body"
        >
          ›
        </button>
        <button
          onClick={reload}
          title="Reload"
          className="rounded px-1.5 font-mono text-xs text-dim hover:bg-white/5 hover:text-body"
        >
          {loading ? '×' : '⟳'}
        </button>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
          }}
          spellCheck={false}
          placeholder="localhost:3000"
          className="min-w-0 flex-1 rounded border border-white/10 bg-black/40 px-2 py-1 font-mono text-[11px] text-body placeholder:text-dim focus:border-[var(--accent)] focus:outline-none"
        />
        <button
          onClick={commit}
          title="Go"
          className="rounded px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-[var(--accent-bright)] hover:bg-white/5"
        >
          Go
        </button>
        <button
          onClick={() => setExpanded((e) => !e)}
          title={expanded ? 'Exit full view (Esc)' : 'Expand to fill the window'}
          className="grid h-6 w-6 place-items-center rounded text-dim hover:bg-white/5 hover:text-body"
        >
          <ExpandIcon collapsed={!expanded} />
        </button>
        <button
          onClick={() => {
            const url = normalizeUrl(address) || previewUrl
            if (url) void window.cosmos.app.openExternal(url)
          }}
          title="Open in your default browser"
          className="rounded px-1.5 font-mono text-xs text-dim hover:bg-white/5 hover:text-body"
        >
          ↗
        </button>
        <button
          onClick={() => togglePanel('preview')}
          title="Hide preview"
          className="rounded px-1.5 font-mono text-xs text-dim hover:bg-white/5 hover:text-body"
        >
          ✕
        </button>
      </div>

      {/* device / zoom bar */}
      <div className="flex h-8 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-white/5 px-2">
        <div className="flex shrink-0 items-center rounded-md bg-black/30 p-0.5">
          {VIEWPORTS.map((v) => (
            <button
              key={v.id}
              onClick={() => pickViewport(v.id)}
              title={v.label}
              className={`grid h-6 w-7 place-items-center rounded transition-colors ${
                viewport === v.id
                  ? 'bg-white/10 text-[var(--accent-bright)]'
                  : 'text-dim hover:text-body'
              }`}
            >
              <DeviceIcon id={v.id} />
            </button>
          ))}
        </div>

        {canRotate && (
          <button
            onClick={() => setRotated((r) => !r)}
            title="Rotate"
            className={`grid h-6 w-6 shrink-0 place-items-center rounded font-mono text-sm transition-colors ${
              rotated ? 'text-[var(--accent-bright)]' : 'text-dim hover:text-body'
            }`}
          >
            ⟲
          </button>
        )}

        {device && (
          <select
            value={typeof zoom === 'number' ? String(zoom) : 'fit'}
            onChange={(e) => setZoom(e.target.value === 'fit' ? 'fit' : Number(e.target.value))}
            title="Zoom"
            className="h-6 shrink-0 rounded border border-white/10 bg-black/40 px-1 font-mono text-[10px] text-body focus:border-[var(--accent)] focus:outline-none"
          >
            {ZOOMS.map((z) => (
              <option key={String(z)} value={typeof z === 'number' ? String(z) : 'fit'}>
                {z === 'fit' ? 'Fit' : `${Math.round(z * 100)}%`}
              </option>
            ))}
          </select>
        )}

        <span className="ml-auto shrink-0 truncate pl-2 font-mono text-[10px] text-dim tabular">
          {readout}
        </span>
      </div>

      {/* the live preview */}
      <div className="relative min-h-0 flex-1">
        {previewUrl ? (
          <div
            ref={stageRef}
            className="smooth-scroll flex h-full w-full overflow-auto"
            style={{
              padding: device ? 24 : 0,
              background: device
                ? 'radial-gradient(120% 120% at 50% 0%, rgba(255,255,255,0.04), transparent 60%), var(--bg)'
                : '#fff'
            }}
          >
            <div style={frameStyle}>
              <webview
                ref={view}
                src={previewUrl}
                partition="persist:studio-preview"
                style={webviewStyle}
              />
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 bg-black/40 p-6 text-center font-ui text-xs text-dim">
            <p>
              Hit <span className="text-[var(--accent-bright)]">▶</span> on an HTML file in the
              Explorer to play it right here.
            </p>
            <p>Or enter a URL above to preview a running dev server.</p>
          </div>
        )}

        {/* indeterminate loading strip */}
        {loading && previewUrl && (
          <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden">
            <div className="h-full w-full animate-pulse bg-[var(--accent)] shadow-[0_0_10px_var(--glow)]" />
          </div>
        )}

        {failed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/85 p-6 text-center">
            <p className="neon font-display text-sm uppercase tracking-[0.3em]">Can't reach it</p>
            <p className="max-w-[300px] font-ui text-xs text-dim">{failed}</p>
            <p className="max-w-[320px] font-ui text-xs text-dim">
              Start your dev server in the terminal (e.g.{' '}
              <span className="font-mono text-[var(--accent-bright)]">npm run dev</span>), then
              Reload.
            </p>
            <button
              onClick={reload}
              className="mt-1 rounded-md border border-[var(--accent-dim)] px-3 py-1 font-ui text-xs text-[var(--accent-bright)] hover:bg-white/5"
            >
              Reload
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
