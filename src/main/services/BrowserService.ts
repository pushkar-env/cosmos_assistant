import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { chromium, type BrowserContext, type Page } from 'playwright-core'

const IDLE_CLOSE_MS = 3 * 60_000
const READ_LIMIT = 15_000

/**
 * Playwright over the user's installed Chrome/Edge (playwright-core,
 * channel launch — no browser downloads). Uses a PERSISTENT profile so
 * cache and cookies survive: YouTube and other sites load fast and fully
 * instead of cold-loading (and hitting consent walls) every time.
 * Powers the browser_* automation tools and media playback (separate tab).
 */
export class BrowserService {
  private context: BrowserContext | null = null
  private page: Page | null = null
  /** a separate tab dedicated to media playback, so automation on the
   *  main tab never navigates away from a playing song */
  private mediaPage: Page | null = null
  private idleTimer: NodeJS.Timeout | null = null

  /** Launch (or reuse) the shared visible browser with a persistent profile. */
  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context
    const userDataDir = join(app.getPath('userData'), 'cosmos-browser')
    await fs.mkdir(userDataDir, { recursive: true }).catch(() => undefined)
    let lastErr: unknown = null
    for (const channel of ['chrome', 'msedge'] as const) {
      try {
        this.context = await chromium.launchPersistentContext(userDataDir, {
          channel,
          headless: false,
          viewport: null,
          // run sandboxed like a real browser (avoids the "--no-sandbox is
          // unsupported" warning bar that shows once automation is hidden)
          chromiumSandbox: true,
          // behave like a normal browser: drop the "controlled by automated
          // software" infobar and the webdriver flag so sites (YouTube!)
          // serve their full, fast page instead of a degraded one
          ignoreDefaultArgs: ['--enable-automation'],
          args: [
            '--start-maximized',
            '--disable-blink-features=AutomationControlled',
            '--autoplay-policy=no-user-gesture-required',
            // memory-lean: cap the process explosion (was ~80 processes /
            // several GB) without hurting playback or automation quality
            '--renderer-process-limit=4',
            '--disable-dev-shm-usage',
            '--disable-extensions',
            '--disable-component-update',
            '--disable-background-networking',
            '--disable-features=Translate,MediaRouter,OptimizationHints'
          ]
        })
        this.context.on('close', () => {
          this.context = null
          this.page = null
          this.mediaPage = null
        })
        return this.context
      } catch (err) {
        lastErr = err
        this.context = null
      }
    }
    throw new Error(
      `No usable browser found (need Edge or Chrome installed): ${
        lastErr instanceof Error ? lastErr.message.split('\n')[0] : lastErr
      }`
    )
  }

  private async ensurePage(): Promise<Page> {
    this.touch()
    if (this.page && !this.page.isClosed()) return this.page
    const ctx = await this.ensureContext()
    // reuse the profile's initial blank tab if it's free
    this.page = ctx.pages().find((p) => p !== this.mediaPage && !p.isClosed()) ?? (await ctx.newPage())
    return this.page
  }

  // ── media playback (separate tab) ──────────────────────────────

  /** Open a URL in the media tab and start it playing (with sound). */
  async playMedia(url: string): Promise<void> {
    if (!/^https?:\/\//.test(url)) throw new Error('Only http(s) URLs are allowed')
    const ctx = await this.ensureContext()
    if (!this.mediaPage || this.mediaPage.isClosed()) {
      // prefer an already-open YouTube tab so a new song plays in the SAME
      // tab; else reuse a spare/blank tab; else open one. Never stack tabs.
      const host = new URL(url).hostname.replace(/^www\./, '')
      const existing = ctx
        .pages()
        .find((p) => !p.isClosed() && p.url().includes(host))
      const spare = ctx.pages().find((p) => p !== this.page && !p.isClosed())
      this.mediaPage = existing ?? spare ?? (await ctx.newPage())
    }
    const page = this.mediaPage
    // 'commit' fires as soon as navigation starts — far more reliable than
    // waiting for a heavy page like YouTube to fully load
    await page.goto(url, { waitUntil: 'commit', timeout: 30_000 })
    await page.bringToFront().catch(() => undefined)
    // give the player a moment, then unmute + play() in case autoplay lags
    await page.waitForTimeout(1500)
    await this.videoAction(page, 'play').catch(() => undefined)
    this.touch()
  }

  /** Control whatever media is in the media tab. */
  async mediaControl(action: string): Promise<string> {
    if (!this.mediaPage || this.mediaPage.isClosed()) {
      throw new Error('Nothing is playing in the COSMOS player.')
    }
    this.touch()
    const result = await this.videoAction(this.mediaPage, action)
    return result
  }

  // ── tab management (COSMOS-controlled browser) ─────────────────

  /** List the open tabs in the COSMOS browser. */
  async listTabs(): Promise<string> {
    if (!this.context) return 'The COSMOS browser is not open.'
    const pages = this.context.pages().filter((p) => !p.isClosed())
    if (pages.length === 0) return 'No open tabs.'
    const rows = await Promise.all(
      pages.map(async (p, i) => {
        let title = ''
        try {
          title = await p.title()
        } catch {
          /* page busy */
        }
        return `${i + 1}. ${title || '(untitled)'} — ${p.url()}`
      })
    )
    return rows.join('\n')
  }

  /**
   * Close tab(s) in the COSMOS browser matching a query (title or URL
   * substring, e.g. "youtube"). Returns what was closed.
   */
  async closeTab(query: string): Promise<string> {
    if (!this.context) throw new Error('The COSMOS browser is not open.')
    const q = query.trim().toLowerCase()
    if (!q) throw new Error('Say which tab to close (e.g. "youtube").')
    const pages = this.context.pages().filter((p) => !p.isClosed())

    const closed: string[] = []
    for (const p of pages) {
      let title = ''
      try {
        title = await p.title()
      } catch {
        /* ignore */
      }
      if (p.url().toLowerCase().includes(q) || title.toLowerCase().includes(q)) {
        closed.push(title || p.url())
        if (p === this.mediaPage) this.mediaPage = null
        if (p === this.page) this.page = null
        await p.close().catch(() => undefined)
      }
    }
    if (closed.length === 0) return `No open tab matched "${query}".`
    return `Closed ${closed.length} tab${closed.length > 1 ? 's' : ''}: ${closed.join(', ')}`
  }

  get isMediaPlaying(): boolean {
    return !!this.mediaPage && !this.mediaPage.isClosed()
  }

  /**
   * Whether audio/video is ACTUALLY playing right now (not just a tab left
   * open). Used by the idle-close so a paused/finished/forgotten media tab no
   * longer pins the whole browser (and its RAM) open indefinitely.
   */
  private async isActuallyPlaying(): Promise<boolean> {
    if (!this.mediaPage || this.mediaPage.isClosed()) return false
    try {
      return await this.mediaPage.evaluate(() => {
        const doc = (globalThis as { document?: unknown }).document as
          | { querySelector(sel: string): { paused: boolean; ended: boolean; currentTime: number } | null }
          | undefined
        const v = doc?.querySelector('video')
        return !!v && !v.paused && !v.ended && v.currentTime > 0
      })
    } catch {
      return false
    }
  }

  private async videoAction(page: Page, action: string): Promise<string> {
    return page.evaluate((act: string) => {
      const doc = (globalThis as { document?: unknown }).document as
        | {
            querySelector(sel: string): {
              paused: boolean
              muted: boolean
              volume: number
              currentTime: number
              duration: number
              play(): Promise<void>
              pause(): void
            } | null
          }
        | undefined
      const v = doc?.querySelector('video')
      if (!v) return 'No video on the current page.'
      switch (act) {
        case 'play':
          v.muted = false
          void v.play().catch(() => undefined)
          return 'Playing.'
        case 'pause':
          v.pause()
          return 'Paused.'
        case 'toggle':
          if (v.paused) {
            v.muted = false
            void v.play().catch(() => undefined)
            return 'Playing.'
          }
          v.pause()
          return 'Paused.'
        case 'mute':
          v.muted = true
          return 'Muted.'
        case 'unmute':
          v.muted = false
          return 'Unmuted.'
        case 'volume-up':
          v.volume = Math.min(1, v.volume + 0.15)
          return `Volume ${Math.round(v.volume * 100)}%.`
        case 'volume-down':
          v.volume = Math.max(0, v.volume - 0.15)
          return `Volume ${Math.round(v.volume * 100)}%.`
        case 'forward':
          v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 10)
          return `Skipped to ${Math.round(v.currentTime)}s.`
        case 'back':
          v.currentTime = Math.max(0, v.currentTime - 10)
          return `Back to ${Math.round(v.currentTime)}s.`
        case 'restart':
          v.currentTime = 0
          void v.play().catch(() => undefined)
          return 'Restarted.'
        default:
          return `Unknown media action: ${act}`
      }
    }, action)
  }

  async goto(url: string): Promise<string> {
    if (!/^https?:\/\//.test(url)) throw new Error('Only http(s) URLs are allowed')
    const page = await this.ensurePage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 })
    return `Loaded "${await page.title()}" — ${page.url()}`
  }

  async readText(): Promise<string> {
    const page = this.requirePage()
    this.touch()
    const text = await page.innerText('body', { timeout: 10_000 })
    const clean = text.replace(/\n{3,}/g, '\n\n').trim()
    return clean.length > READ_LIMIT
      ? `${clean.slice(0, READ_LIMIT)}\n… [truncated, page continues]`
      : clean || '(page has no visible text)'
  }

  async search(query: string): Promise<string> {
    const page = await this.ensurePage()
    // Bing in a real browser: robust, rarely challenges, stable selectors.
    await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`, {
      waitUntil: 'domcontentloaded',
      timeout: 25_000
    })
    try {
      const results = await page.$$eval('li.b_algo', (items) =>
        items.slice(0, 8).map((li) => {
          const a = li.querySelector('h2 a')
          const cap = li.querySelector('.b_caption p, .b_algoSlug')
          return {
            title: (a?.textContent ?? '').trim(),
            href: a?.getAttribute('href') ?? '',
            snippet: (cap?.textContent ?? '').trim()
          }
        })
      )
      const clean = results.filter((r) => r.title && r.href)
      if (clean.length > 0) {
        return clean
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.href}${r.snippet ? `\n   ${r.snippet.slice(0, 180)}` : ''}`)
          .join('\n')
      }
    } catch {
      /* markup changed — fall back to raw text */
    }
    return this.readText()
  }

  /** list interactive form fields so the agent can target them */
  async listInputs(): Promise<string> {
    const page = this.requirePage()
    this.touch()
    const inputs = await page.$$eval('input, textarea, select, button[type=submit]', (els) =>
      els.slice(0, 40).map((el) => {
        const e = el as unknown as {
          type?: string
          name?: string
          id?: string
          placeholder?: string
          value?: string
        }
        return [
          el.tagName.toLowerCase(),
          e.type ? `type=${e.type}` : '',
          e.name ? `name=${e.name}` : '',
          e.id ? `id=${e.id}` : '',
          e.placeholder ? `placeholder="${e.placeholder}"` : '',
          e.value && e.type !== 'password' ? `value="${e.value.slice(0, 30)}"` : ''
        ]
          .filter(Boolean)
          .join(' ')
      })
    )
    return inputs.length ? inputs.join('\n') : 'No form fields found.'
  }

  async click(target: string): Promise<string> {
    const page = this.requirePage()
    this.touch()
    const locator = /^[.#[]|^\/\//.test(target)
      ? page.locator(target).first()
      : page.getByText(target, { exact: false }).first()
    await locator.click({ timeout: 8_000 })
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined)
    return `Clicked "${target}" — now on "${await page.title()}" (${page.url()})`
  }

  async type(field: string, text: string, pressEnter: boolean): Promise<string> {
    const page = this.requirePage()
    this.touch()
    // resolve by css, then name/id/placeholder attribute
    const candidates = /^[.#[]/.test(field)
      ? [page.locator(field).first()]
      : [
          page.locator(`[name="${field}"]`).first(),
          page.locator(`#${field}`).first(),
          page.getByPlaceholder(field).first(),
          page.getByLabel(field).first()
        ]
    for (const locator of candidates) {
      try {
        await locator.fill(text, { timeout: 4_000 })
        if (pressEnter) {
          await locator.press('Enter')
          await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined)
        }
        return `Typed into "${field}"${pressEnter ? ' and submitted' : ''}.`
      } catch {
        /* try next resolution strategy */
      }
    }
    throw new Error(`Could not find field "${field}" — use browser_inputs to inspect the form`)
  }

  async screenshot(): Promise<string> {
    const page = this.requirePage()
    this.touch()
    const dir = join(app.getPath('pictures'), 'COSMOS Screenshots')
    await fs.mkdir(dir, { recursive: true })
    const file = join(dir, `browser-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
    await page.screenshot({ path: file })
    return `Saved page screenshot: ${file}`
  }

  async stopMedia(): Promise<void> {
    if (this.mediaPage && !this.mediaPage.isClosed()) {
      await this.mediaPage.close().catch(() => undefined) // close the tab, keep the browser
    }
    this.mediaPage = null
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.page = null
    this.mediaPage = null
    if (this.context) {
      await this.context.close().catch(() => undefined)
      this.context = null
    }
  }

  private requirePage(): Page {
    if (!this.page || this.page.isClosed()) {
      throw new Error('No page is open — use browser_goto first')
    }
    return this.page
  }

  /** Reset the idle-close timer. Active playback keeps the browser alive. */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => void this.onIdle(), IDLE_CLOSE_MS)
  }

  /** idle fired: keep the browser only if media is genuinely playing */
  private async onIdle(): Promise<void> {
    if (await this.isActuallyPlaying()) this.touch()
    else await this.close()
  }
}
