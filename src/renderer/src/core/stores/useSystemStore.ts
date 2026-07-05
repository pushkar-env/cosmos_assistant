import { create } from 'zustand'
import type { SystemStats, WeatherInfo } from '@shared/types'

interface SystemState {
  stats: SystemStats | null
  weather: WeatherInfo | null
  init: () => void
}

let initialized = false

export const useSystemStore = create<SystemState>((set) => ({
  stats: null,
  weather: null,

  init: () => {
    if (initialized) return
    initialized = true

    window.cosmos.system.onStats((stats) => set({ stats }))

    const loadWeather = async (): Promise<void> => {
      const weather = await window.cosmos.weather.get()
      if (weather) set({ weather })
    }
    void loadWeather()
    setInterval(() => void loadWeather(), 10 * 60_000)
  }
}))
