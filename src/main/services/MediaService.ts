import { shell } from 'electron'
import type { BrowserService } from './BrowserService'
import type { SettingsService } from './SettingsService'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

/**
 * Media playback that actually starts. Two modes (Settings → Media):
 *  - dedicated: opens in the COSMOS-controlled browser tab which autoplays
 *    with sound and can be paused / played / seeked by voice or tools.
 *  - default:   opens in your normal default browser (natural look; the
 *    browser's own autoplay policy applies, so you may need to hit play).
 */
export class MediaService {
  constructor(
    private readonly browser: BrowserService,
    private readonly settings: SettingsService
  ) {}

  /** Resolve a query to the top YouTube video and start it playing. */
  async playYouTube(query: string): Promise<string> {
    const q = query.trim()
    if (!q) throw new Error('Nothing to play')

    const video = await this.topYouTubeVideo(q)
    if (!video) {
      await shell.openExternal(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`)
      throw new Error(`Couldn't find a video for "${q}" — opened YouTube search instead`)
    }

    const mode = this.settings.get().mediaPlayer
    if (mode === 'default') {
      await shell.openExternal(`${video.url}&autoplay=1`)
      return `Opened ${video.title} in your default browser (press play if it doesn't start).`
    }

    try {
      await this.browser.playMedia(`${video.url}&autoplay=1`)
      return `▶ Now playing: ${video.title}`
    } catch {
      await shell.openExternal(`${video.url}&autoplay=1`)
      return `Opened ${video.title} in your browser (COSMOS player unavailable).`
    }
  }

  /** Control the dedicated player (play/pause/seek/volume/…). */
  async control(action: string): Promise<string> {
    if (this.settings.get().mediaPlayer === 'default') {
      throw new Error(
        'Playback controls only work with the COSMOS player. Switch Media mode to "dedicated" in Settings, or control the video in your browser.'
      )
    }
    return this.browser.mediaControl(action)
  }

  async stop(): Promise<string> {
    await this.browser.stopMedia()
    return 'Playback stopped.'
  }

  private async topYouTubeVideo(query: string): Promise<{ url: string; title: string } | null> {
    const res = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%3D%3D`,
      { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(15_000) }
    )
    if (!res.ok) return null
    const html = await res.text()
    const idMatch = html.match(/"videoId":"([\w-]{11})"/)
    if (!idMatch) return null
    const id = idMatch[1]
    const idx = html.indexOf(`"videoId":"${id}"`)
    const titleMatch = html.slice(idx, idx + 800).match(/"title":\{"runs":\[\{"text":"([^"]+)"/)
    const title = titleMatch ? decodeJsonString(titleMatch[1]) : 'YouTube video'
    return { url: `https://www.youtube.com/watch?v=${id}`, title }
  }
}

function decodeJsonString(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string
  } catch {
    return s
  }
}
