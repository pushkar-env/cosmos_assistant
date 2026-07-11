import { useStudioStore, type PanelId } from './useStudioStore'

const ITEMS: { id: PanelId; label: string; glyph: string }[] = [
  { id: 'explorer', label: 'Explorer', glyph: '🗀' },
  { id: 'chat', label: 'Chat', glyph: '💬' },
  { id: 'preview', label: 'Preview', glyph: '◧' },
  { id: 'terminal', label: 'Terminal', glyph: '❯_' }
]

/** VS Code-style vertical rail: one toggle per dockable panel. */
export function ActivityBar(): React.JSX.Element {
  const panels = useStudioStore((s) => s.panels)
  const togglePanel = useStudioStore((s) => s.togglePanel)

  return (
    <div className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-white/5 bg-black/20 py-2">
      {ITEMS.map((it) => {
        const active = panels[it.id]
        return (
          <button
            key={it.id}
            onClick={() => togglePanel(it.id)}
            title={`${active ? 'Hide' : 'Show'} ${it.label}`}
            className={`relative grid h-9 w-9 place-items-center rounded-md font-mono text-sm transition-colors ${
              active
                ? 'bg-white/10 text-[var(--accent-bright)]'
                : 'text-dim hover:bg-white/5 hover:text-body'
            }`}
          >
            {active && (
              <span
                className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full"
                style={{ background: 'var(--accent)' }}
              />
            )}
            <span className="text-[13px] leading-none">{it.glyph}</span>
          </button>
        )
      })}
    </div>
  )
}
