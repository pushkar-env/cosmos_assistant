import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { chromium, type Browser, type Page } from 'playwright-core'

const IDLE_CLOSE_MS = 3 * 60_000
const READ_LIMIT = 15_000

/**
 * Playwright over the user's installed Edge/Chrome (playwright-core,
 * channel launch — no browser downloads). One lazy headless session,
 * auto-closed after idle. Used by the browser_* tools and the
 * Researcher agent.
 */
export class BrowserService {
  private browser: Browser | null = null
  private page: Page | null = null
  private idleTimer: NodeJS.Timeout | null = null

  private async ensurePage(): Promise<Page> {
    this.touch()
    if (this.page && !this.page.isClosed()) return this.page

    if (!this.browser?.isConnected()) {
      let lastErr: unknown = null
      // prefer Chrome (most users' default) so the automation window,
      // when it's actually needed, matches their normal browser
      for (const channel of ['chrome', 'msedge'] as const) {
        try {
          // visible, not headless: the user watches COSMOS drive the page
          // (form-fill, clicks, logins). Audio-playing media goes through
          // the real default browser via MediaService instead.
          this.browser = await chromium.launch({
            channel,
            headless: false,
            args: ['--start-maximized', '--mute-audio']
          })
          break
        } catch (err) {
          lastErr = err
          this.browser = null
        }
      }
      if (!this.browser) {
        throw new Error(
          `No usable browser found (need Edge or Chrome installed): ${
            lastErr instanceof Error ? lastErr.message.split('\n')[0] : lastErr
          }`
        )
      }
    }
    const context = await this.browser.newContext({ viewport: { width: 1280, height: 900 } })
    this.page = await context.newPage()
    return this.page
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

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.page = null
    if (this.browser) {
      await this.browser.close().catch(() => undefined)
      this.browser = null
    }
  }

  private requirePage(): Page {
    if (!this.page || this.page.isClosed()) {
      throw new Error('No page is open — use browser_goto first')
    }
    return this.page
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => void this.close(), IDLE_CLOSE_MS)
  }
}
