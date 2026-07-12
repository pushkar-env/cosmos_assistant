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

interface UIState {
  phase: Phase
  paletteOpen: boolean
  activePanel: Panel
  mode: WindowMode
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

  init: () => {
    if (initialized) return
    initialized = true
    // main can change the mode too (tray, shortcuts) — mirror it
    window.cosmos.app.onModeChanged((mode) => set({ mode }))
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
