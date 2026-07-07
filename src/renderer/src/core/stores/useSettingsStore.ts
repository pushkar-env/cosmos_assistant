import { create } from 'zustand'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import { applyTheme } from '@/core/theme/themes'

interface SettingsState {
  settings: Settings
  loaded: boolean
  init: () => Promise<void>
  update: (patch: Partial<Settings>) => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  init: async () => {
    // a transient IPC failure here would strand the whole session on
    // DEFAULT_SETTINGS (wrong voice, no keys) — retry before giving up
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const settings = await window.cosmos.settings.get()
        applyTheme(settings.theme)
        set({ settings, loaded: true })
        return
      } catch (err) {
        console.error(`[settings] load attempt ${attempt + 1} failed:`, err)
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
      }
    }
    console.error('[settings] all load attempts failed — running on defaults')
  },

  update: async (patch) => {
    // optimistic: apply locally, persist through main
    const next = {
      ...get().settings,
      ...patch,
      apiKeys: { ...get().settings.apiKeys, ...patch.apiKeys },
      providerModels: { ...get().settings.providerModels, ...patch.providerModels },
      location: { ...get().settings.location, ...patch.location },
      voice: { ...get().settings.voice, ...patch.voice }
    }
    if (patch.theme) applyTheme(patch.theme)
    set({ settings: next })
    const confirmed = await window.cosmos.settings.set(patch)
    set({ settings: confirmed })
  }
}))
