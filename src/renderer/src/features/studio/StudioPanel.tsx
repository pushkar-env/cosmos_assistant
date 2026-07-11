import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useUIStore } from '@/core/stores/useUIStore'
import { useSettingsStore } from '@/core/stores/useSettingsStore'
import { CodeEditor } from './CodeEditor'
import { useStudioStore } from './useStudioStore'
import { ActivityBar } from './ActivityBar'
import { FileExplorer, extColor } from './FileExplorer'
import { StudioTerminals } from './StudioTerminals'
import { StudioPreview } from './StudioPreview'
import { StudioChat } from './StudioChat'
import { Resizer } from './Resizer'

/** the slim bottom status strip */
function StatusStrip(): React.JSX.Element {
  const root = useStudioStore((s) => s.root)
  const git = useStudioStore((s) => s.git)
  const reveal = useStudioStore((s) => s.reveal)
  const tabs = useStudioStore((s) => s.tabs)
  const activePath = useStudioStore((s) => s.activePath)
  const active = tabs.find((t) => t.path === activePath)
  const shortRoot = root.replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~')

  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-white/5 bg-black/30 px-3">
      {git?.isRepo && (
        <span className="flex items-center gap-1.5 font-mono text-[10px]">
          <span className="text-[var(--accent-bright)]">⎇ {git.branch || 'HEAD'}</span>
          {!git.clean && (
            <span className="text-amber-300">●{git.staged + git.unstaged + git.untracked}</span>
          )}
          {git.ahead > 0 && <span className="text-dim">↑{git.ahead}</span>}
          {git.behind > 0 && <span className="text-dim">↓{git.behind}</span>}
        </span>
      )}
      <button
        onClick={() => reveal()}
        title="Reveal in File Explorer"
        className="max-w-[420px] truncate font-mono text-[10px] text-dim hover:text-body"
      >
        {shortRoot || 'workspace'}
      </button>
      <span className="ml-auto truncate font-mono text-[10px] text-dim">
        {active ? active.name + (active.dirty ? ' ●' : '') : 'No file open'}
      </span>
    </div>
  )
}

/** the editor column: tab bar + CodeEditor / empty state */
function EditorArea(): React.JSX.Element {
  const tabs = useStudioStore((s) => s.tabs)
  const activePath = useStudioStore((s) => s.activePath)
  const setActive = useStudioStore((s) => s.setActive)
  const closeTab = useStudioStore((s) => s.closeTab)
  const editActive = useStudioStore((s) => s.editActive)
  const saveActive = useStudioStore((s) => s.saveActive)
  const activeTab = tabs.find((t) => t.path === activePath)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* tab bar */}
      <div className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-white/5 px-1">
        {tabs.map((t) => (
          <div
            key={t.path}
            onClick={() => setActive(t.path)}
            className={`group flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded px-2.5 text-left ${
              t.path === activePath ? 'bg-white/10' : 'hover:bg-white/5'
            }`}
            title={t.path}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: extColor(t.name) }} />
            <span className="font-ui text-xs text-body">{t.name}</span>
            {t.dirty && <span className="text-[var(--accent)]">●</span>}
            <button
              onClick={(e) => {
                e.stopPropagation()
                closeTab(t.path)
              }}
              className="rounded px-0.5 font-mono text-[11px] text-dim opacity-0 hover:text-body group-hover:opacity-100"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* editor */}
      <div className="relative min-h-0 flex-1">
        {activeTab ? (
          activeTab.truncated ? (
            <div className="flex h-full items-center justify-center p-6 text-center font-ui text-sm text-dim">
              {activeTab.content}
            </div>
          ) : (
            <CodeEditor
              key={activeTab.path}
              path={activeTab.path}
              value={activeTab.content}
              onChange={editActive}
              onSave={() => void saveActive()}
            />
          )
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="neon font-display text-2xl font-bold tracking-[0.3em] opacity-30">
              COSMOS
            </span>
            <p className="font-ui text-xs text-dim">
              Open a file from the Explorer, or ask COSMOS to build a project in Agent mode.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

export function StudioPanel(): React.JSX.Element {
  const open = useUIStore((s) => s.activePanel === 'studio')
  const setPanel = useUIStore((s) => s.setPanel)
  const init = useStudioStore((s) => s.init)
  const pickRoot = useStudioStore((s) => s.pickRoot)
  const openFileDialog = useStudioStore((s) => s.openFileDialog)
  const root = useStudioStore((s) => s.root)
  const git = useStudioStore((s) => s.git)
  const panels = useStudioStore((s) => s.panels)
  const sizes = useStudioStore((s) => s.sizes)
  const setSize = useStudioStore((s) => s.setSize)
  const autoRun = useSettingsStore((s) => s.settings.agentAutoApprove)
  const updateSettings = useSettingsStore((s) => s.update)

  useEffect(() => {
    if (open) void init()
  }, [open, init])

  const shortRoot = root.replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~')

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-40 flex flex-col"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          style={{ background: 'var(--bg)' }}
        >
          {/* header — draggable window region; buttons opt out of drag */}
          <div
            className="flex items-center justify-between border-b border-white/10 px-4 py-2"
            style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
          >
            <div
              className="flex items-center gap-3"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <span className="neon font-display text-xs font-bold tracking-[0.3em]">
                COSMOS STUDIO
              </span>
              <button
                onClick={() => useStudioStore.getState().reveal()}
                title="Reveal in File Explorer"
                className="max-w-[320px] truncate rounded bg-black/30 px-2 py-1 font-mono text-[10px] text-dim hover:text-body"
              >
                {shortRoot || 'workspace'}
              </button>
              {git?.isRepo && (
                <span className="hidden items-center gap-1.5 rounded bg-black/30 px-2 py-1 font-mono text-[10px] md:flex">
                  <span className="text-[var(--accent-bright)]">⎇ {git.branch || 'HEAD'}</span>
                  {!git.clean && (
                    <span className="text-amber-300">
                      ●{git.staged + git.unstaged + git.untracked}
                    </span>
                  )}
                </span>
              )}
            </div>
            <div
              className="flex items-center gap-1"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <button
                onClick={() => void openFileDialog()}
                className="rounded-md px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-dim hover:bg-white/5 hover:text-body"
              >
                Open File
              </button>
              <button
                onClick={() => void pickRoot()}
                className="rounded-md px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-dim hover:bg-white/5 hover:text-body"
              >
                Open Folder
              </button>
              <button
                onClick={() => void updateSettings({ agentAutoApprove: !autoRun })}
                title="Autonomous Builder — let the agent run its own terminal & file commands (install, build, test) without approving each step. Agent/Ultra mode only; Stop always interrupts."
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors ${
                  autoRun
                    ? 'border-[var(--accent-dim)] text-[var(--accent-bright)]'
                    : 'border-white/10 text-dim hover:text-body'
                }`}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: autoRun ? 'var(--accent)' : 'var(--dim)' }}
                />
                Auto-run
              </button>
              <div className="mx-1 h-4 w-px bg-white/10" />
              <button
                onClick={() => void window.cosmos.app.windowControl('minimize')}
                title="Minimize"
                className="grid h-7 w-7 place-items-center rounded font-mono text-xs text-dim hover:bg-white/5 hover:text-body"
              >
                –
              </button>
              <button
                onClick={() => void window.cosmos.app.windowControl('maximize')}
                title="Maximize / Restore"
                className="grid h-7 w-7 place-items-center rounded font-mono text-xs text-dim hover:bg-white/5 hover:text-body"
              >
                ☐
              </button>
              <button
                onClick={() => setPanel('none')}
                title="Close Studio (Esc)"
                className="grid h-7 w-7 place-items-center rounded font-mono text-xs text-dim hover:bg-red-500/20 hover:text-red-300"
              >
                ✕
              </button>
            </div>
          </div>

          {/* body */}
          <div className="flex min-h-0 flex-1">
            <ActivityBar />

            {/* explorer */}
            {panels.explorer && (
              <>
                <div
                  className="flex shrink-0 flex-col border-r border-white/5"
                  style={{ width: sizes.explorerWidth }}
                >
                  <FileExplorer />
                </div>
                <Resizer
                  axis="x"
                  value={sizes.explorerWidth}
                  min={160}
                  max={480}
                  onChange={(v) => setSize('explorerWidth', v)}
                />
              </>
            )}

            {/* center column: editor (+ preview) over terminal */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1">
                <EditorArea />
                {panels.preview && (
                  <>
                    <Resizer
                      axis="x"
                      value={sizes.previewWidth}
                      invert
                      min={280}
                      max={1000}
                      onChange={(v) => setSize('previewWidth', v)}
                    />
                    <div className="shrink-0" style={{ width: sizes.previewWidth }}>
                      <StudioPreview />
                    </div>
                  </>
                )}
              </div>
              {panels.terminal && (
                <>
                  <Resizer
                    axis="y"
                    value={sizes.terminalHeight}
                    invert
                    min={100}
                    max={640}
                    onChange={(v) => setSize('terminalHeight', v)}
                  />
                  <div
                    className="shrink-0 border-t border-white/10"
                    style={{ height: sizes.terminalHeight }}
                  >
                    <StudioTerminals />
                  </div>
                </>
              )}
            </div>

            {/* chat */}
            {panels.chat && (
              <>
                <Resizer
                  axis="x"
                  value={sizes.chatWidth}
                  invert
                  min={300}
                  max={640}
                  onChange={(v) => setSize('chatWidth', v)}
                />
                <div className="shrink-0" style={{ width: sizes.chatWidth }}>
                  <StudioChat />
                </div>
              </>
            )}
          </div>

          <StatusStrip />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
