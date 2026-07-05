import { shell } from 'electron'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

/**
 * Media playback that the user actually hears. The automation browser
 * is headless (no audio), so media opens in the user's real default
 * browser: we resolve the query to a concrete watch/play URL first, then
 * hand it to the OS so it autoplays.
 */
export class MediaService {
  /** Resolve a query to the top YouTube video and open it playing. */
  async playYouTube(query: string): Promise<string> {
    const q = query.trim()
    if (!q) throw new Error('Nothing to play')
    const video = await this.topYouTubeVideo(q)
    if (!video) {
      // fall back to opening the search page so the user still gets somewhere
      await shell.openExternal(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`)
      throw new Error(`Couldn't resolve a video for "${q}" — opened YouTube search instead`)
    }
    // &autoplay=1 nudges the video to start on its own in the default browser
    await shell.openExternal(`${video.url}&autoplay=1`)
    return `Now playing in your browser: ${video.title} — ${video.url}`
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
    // title sits near the first videoId occurrence
    const idx = html.indexOf(`"videoId":"${id}"`)
    const titleMatch = html
      .slice(idx, idx + 800)
      .match(/"title":\{"runs":\[\{"text":"([^"]+)"/)
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
