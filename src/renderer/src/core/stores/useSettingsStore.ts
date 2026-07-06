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
    const settings = await window.cosmos.settings.get()
    applyTheme(settings.theme)
    set({ settings, loaded: true })
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
