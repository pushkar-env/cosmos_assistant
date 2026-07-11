import { useEffect, useRef, useState } from 'react'
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

export function StudioPreview(): React.JSX.Element {
  const previewUrl = useStudioStore((s) => s.previewUrl)
  const setPreviewUrl = useStudioStore((s) => s.setPreviewUrl)
  const togglePanel = useStudioStore((s) => s.togglePanel)
  const view = useRef<WebviewEl | null>(null)
  const [address, setAddress] = useState(previewUrl)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  // keep the address bar in sync when the committed url changes elsewhere
  useEffect(() => setAddress(previewUrl), [previewUrl])

  // wire webview lifecycle events → address bar + loading/error states
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
  }, [])

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

  return (
    <div className="flex h-full flex-col border-l border-white/5 bg-black/20">
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
      {/* the live preview */}
      <div className="relative min-h-0 flex-1 bg-white">
        {previewUrl ? (
          <webview
            ref={view}
            src={previewUrl}
            partition="persist:studio-preview"
            className="h-full w-full"
            style={{ display: 'inline-flex', width: '100%', height: '100%' }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 bg-black/40 p-6 text-center font-ui text-xs text-dim">
            <p>
              Hit <span className="text-[var(--accent-bright)]">▶</span> on an HTML file in the
              Explorer to play it right here.
            </p>
            <p>Or enter a URL above to preview a running dev server.</p>
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
