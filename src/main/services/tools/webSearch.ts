/**
 * Keyless web search backends for the research tools.
 *  - DuckDuckGo HTML (general search, titles + snippets, fast HTTP)
 *  - Google News RSS (current events, dated results)
 * Both verified live; the browser session is only a fallback.
 */

// a normal Chrome UA — a custom "COSMOS research" UA gets bot-blocked fast
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&\w+;/g, ' ')
}

export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

/**
 * Fetch a page and extract its main readable text (article paragraphs first,
 * then a stripped fallback). Best-effort — returns '' on failure/thin pages so
 * the research tool can fall back to the search snippet.
 */
export async function fetchArticleText(url: string, maxChars = 2500): Promise<string> {
  let html: string
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(12_000)
    })
    if (!res.ok) return ''
    html = await res.text()
  } catch {
    return ''
  }
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  // article body is almost always in <p> tags — join the substantive ones
  const paras = [...cleaned.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripTags(m[1]))
    .filter((t) => t.length > 40)
  let text = paras.join(' ')
  if (text.length < 200) text = stripTags(cleaned) // fallback: whole page
  return text.slice(0, maxChars)
}

export interface SearchResult {
  title: string
  url: string
  snippet?: string
  date?: string
  source?: string
}

export class CaptchaError extends Error {
  constructor(source: string) {
    super(`${source} returned a CAPTCHA/anti-bot challenge`)
    this.name = 'CaptchaError'
  }
}

function looksLikeCaptcha(html: string): boolean {
  const h = html.toLowerCase()
  return (
    h.includes('unusual traffic') ||
    h.includes('are you a robot') ||
    h.includes('/challenge') ||
    h.includes('captcha') ||
    h.includes('anomaly-modal')
  )
}

async function scrapeDdg(url: string, source: string): Promise<SearchResult[]> {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`${source} HTTP ${res.status}`)
  const html = await res.text()

  const links: { title: string; url: string }[] = []
  const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(html)) !== null && links.length < 8) {
    let u = m[1]
    const uddg = /[?&]uddg=([^&]+)/.exec(u)
    if (uddg) u = decodeURIComponent(uddg[1])
    if (u.startsWith('//')) u = 'https:' + u
    links.push({ title: stripTags(m[2]), url: u })
  }
  const snippets: string[] = []
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  while ((m = snipRe.exec(html)) !== null && snippets.length < 8) snippets.push(stripTags(m[1]))

  // no results AND a challenge page → distinguish CAPTCHA from "no hits"
  if (links.length === 0 && looksLikeCaptcha(html)) throw new CaptchaError(source)
  return links.map((l, i) => ({ ...l, snippet: snippets[i] }))
}

export async function ddgSearch(query: string): Promise<SearchResult[]> {
  const q = encodeURIComponent(query)
  try {
    const r = await scrapeDdg(`https://html.duckduckgo.com/html/?q=${q}`, 'DuckDuckGo')
    if (r.length > 0) return r
  } catch (err) {
    if (!(err instanceof CaptchaError)) throw err
    // fall through to the lite endpoint, which rarely challenges
  }
  return scrapeDdg(`https://lite.duckduckgo.com/lite/?q=${q}`, 'DuckDuckGo Lite')
}

export async function newsSearch(query: string): Promise<SearchResult[]> {
  const res = await fetch(
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
    { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) }
  )
  if (!res.ok) throw new Error(`Google News HTTP ${res.status}`)
  const xml = await res.text()

  const items: SearchResult[] = []
  const itemRe = /<item>([\s\S]*?)<\/item>/g
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) !== null && items.length < 10) {
    const block = m[1]
    const pick = (tag: string): string => {
      const r = new RegExp(
        `<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`
      ).exec(block)
      return r ? stripTags(r[1]) : ''
    }
    items.push({
      title: pick('title'),
      url: pick('link'),
      date: pick('pubDate'),
      source: pick('source')
    })
  }
  return items
}

export function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No results.'
  return results
    .map((r, i) => {
      const meta = [r.date, r.source].filter(Boolean).join(' · ')
      return (
        `${i + 1}. ${r.title}${meta ? ` (${meta})` : ''}\n   ${r.url}` +
        (r.snippet ? `\n   ${r.snippet.slice(0, 200)}` : '')
      )
    })
    .join('\n')
}
