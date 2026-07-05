import type { WeatherInfo } from '@shared/types'
import type { SettingsService } from './SettingsService'

const WMO_DESCRIPTIONS: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mostly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  80: 'Rain showers',
  81: 'Rain showers',
  82: 'Violent showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm + hail',
  99: 'Thunderstorm + hail'
}

/**
 * Keyless weather: geolocates once via IP (ipapi.co), then reads
 * Open-Meteo. Caches for 10 minutes.
 */
export class WeatherService {
  private cached: { at: number; data: WeatherInfo } | null = null

  constructor(private readonly settings: SettingsService) {}

  async get(): Promise<WeatherInfo | null> {
    if (this.cached && Date.now() - this.cached.at < 10 * 60_000) {
      return this.cached.data
    }
    try {
      const loc = await this.resolveLocation()
      if (!loc) return null

      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
        `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m`
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) return null
      const body = (await res.json()) as {
        current: {
          temperature_2m: number
          apparent_temperature: number
          relative_humidity_2m: number
          weather_code: number
          wind_speed_10m: number
        }
      }
      const c = body.current
      const data: WeatherInfo = {
        location: loc.label,
        tempC: c.temperature_2m,
        feelsLikeC: c.apparent_temperature,
        windKph: c.wind_speed_10m,
        humidity: c.relative_humidity_2m,
        code: c.weather_code,
        description: WMO_DESCRIPTIONS[c.weather_code] ?? 'Unknown'
      }
      this.cached = { at: Date.now(), data }
      return data
    } catch (err) {
      console.error('[weather] fetch failed:', err)
      return null
    }
  }

  private async resolveLocation(): Promise<{ lat: number; lon: number; label: string } | null> {
    const saved = this.settings.get().location
    if (saved.lat != null && saved.lon != null) {
      return { lat: saved.lat, lon: saved.lon, label: saved.label || 'Saved location' }
    }
    try {
      const res = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(8000) })
      if (!res.ok) return null
      const geo = (await res.json()) as { latitude: number; longitude: number; city: string }
      if (typeof geo.latitude !== 'number') return null
      const loc = { lat: geo.latitude, lon: geo.longitude, label: geo.city ?? 'Unknown' }
      this.settings.set({ location: { ...loc, label: loc.label } })
      return loc
    } catch {
      return null
    }
  }
}
