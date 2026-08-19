import { create } from 'zustand'
import type { WindowMode } from '@shared/ipc'

type Phase = 'boot' | 'main'
type Panel =
  | 'none'
  | 'settings'
  | 'vault'
  | 'secrets'
  | 'dashboard'
  | 'workspace'
  | 'apps'
  | 'studio'
  | 'personality'
  | 'cleaner'

interface UIState {
  phase: Phase
  paletteOpen: boolean
  activePanel: Panel
  mode: WindowMode
  /** false while the window is hidden to tray or minimised — visual loops park */
  windowVisible: boolean
  init: () => void
  finishBoot: () => void
  togglePalette: (open?: boolean) => void
  setPanel: (panel: Panel) => void
  /** switch window presentation: full app / compact panel / floating orb */
  setMode: (mode: WindowMode) => void
  /** convenience: compact ⇄ full toggle */
  toggleCompact: () => void
}

let initialized = false

export const useUIStore = create<UIState>((set, get) => ({
  phase: 'boot',
  paletteOpen: false,
  activePanel: 'none',
  mode: 'full',
  windowVisible: true,

  init: () => {
    if (initialized) return
    initialized = true
    // main can change the mode too (tray, shortcuts) — mirror it
    window.cosmos.app.onModeChanged((mode) => set({ mode }))
    // Chromium will not throttle us (backgroundThrottling is off, so voice
    // survives the tray), so main tells us when nobody can see the window and
    // the animation loops should stand down.
    window.cosmos.app.onWindowHidden(() => set({ windowVisible: false }))
    window.cosmos.app.onWindowShown(() => set({ windowVisible: true }))
  },

  finishBoot: () => set({ phase: 'main' }),
  togglePalette: (open) => set((s) => ({ paletteOpen: open ?? !s.paletteOpen })),
  setPanel: (panel) => set({ activePanel: panel }),

  setMode: (mode) => {
    void window.cosmos.app.setMode(mode)
    set({ mode, activePanel: 'none', paletteOpen: false })
  },

  toggleCompact: () => get().setMode(get().mode === 'full' ? 'compact' : 'full')
}))
