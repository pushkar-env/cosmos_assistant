import type { ToolSpec } from './ToolRegistry'
import type { BrowserService } from '../BrowserService'
import {
  ddgSearch,
  newsSearch,
  formatResults,
  fetchArticleText,
  CaptchaError,
  type SearchResult
} from './webSearch'

const FETCH_LIMIT = 12_000
/** below this, assume a JS-rendered page and re-read via the browser */
const THIN_PAGE_CHARS = 400

export function browserTools(browser: BrowserService): ToolSpec[] {
  return [
    {
      def: {
        name: 'web_fetch',
        description:
          'Fetch a URL and return its text content (fast, no browser). Best for articles and docs; use browser_* tools for interactive pages.',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url']
        },
        sensitive: false
      },
      summary: (a) => String(a.url ?? ''),
      run: async (a) => {
        const url = String(a.url)
        if (!/^https?:\/\//.test(url)) throw new Error('Only http(s) URLs are allowed')
        let text = ''
        try {
          const res = await fetch(url, {
            signal: AbortSignal.timeout(20_000),
            headers: {
              'user-agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
          })
          if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
          const html = await res.text()
          text = html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#\d+;|&\w+;/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim()
        } catch (err) {
          // blocked or unreachable over plain HTTP — try the real browser
          await browser.goto(url)
          const rendered = await browser.readText()
          return `[rendered via browser]\n${rendered}`
        }
        if (text.length < THIN_PAGE_CHARS) {
          // JS-rendered page: static HTML was empty shell, render it
          try {
            await browser.goto(url)
            const rendered = await browser.readText()
            if (rendered.length > text.length) return `[rendered via browser]\n${rendered}`
          } catch {
            /* fall through with the thin static text */
          }
        }
        return text.length > FETCH_LIMIT
          ? `${text.slice(0, FETCH_LIMIT)}\n… [truncated]`
          : text || '(no text content)'
      }
    },
    {
      def: {
        name: 'web_search',
        description:
          'Quick web search — returns top results as titles, URLs and snippets only. For a DETAILED answer that actually reads the sources, use the `research` tool instead of this.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query']
        },
        sensitive: false
      },
      summary: (a) => String(a.query ?? ''),
      run: async (a) => {
        const query = String(a.query)
        // 1. DuckDuckGo (html → lite fallback inside ddgSearch)
        try {
          const results = await ddgSearch(query)
          if (results.length > 0) return formatResults(results)
        } catch (err) {
          if (!(err instanceof CaptchaError)) {
            /* network/other — keep going through the fallbacks */
          }
        }
        // 2. Google News (different infra, rarely challenges — general enough)
        try {
          const news = await newsSearch(query)
          if (news.length > 0) return `(via news index)\n${formatResults(news)}`
        } catch {
          /* keep going */
        }
        // 3. the real (visible) browser — can clear soft challenges
        try {
          return await browser.search(query)
        } catch {
          return `All search backends were blocked or unreachable for "${query}". Try rephrasing, or I can open the search page in your browser.`
        }
      }
    },
    {
      def: {
        name: 'news_search',
        description:
          'Quick current-news lookup (Google News) — returns dated headlines with sources only. For a DETAILED news answer that reads the articles, use the `research` tool with recency:true instead.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query']
        },
        sensitive: false
      },
      summary: (a) => String(a.query ?? ''),
      run: async (a) => formatResults(await newsSearch(String(a.query)))
    },
    {
      def: {
        name: 'research',
        description:
          'Deep research in ONE step: searches the web, then fetches and READS the top sources and returns their actual article text (not just links). Use this whenever the user wants details, "latest news", "tell me about X", "what\'s happening with Y", explanations, comparisons, or anything current/in-depth. After it returns, WRITE A DETAILED, well-organized answer synthesizing the sources (cite source names/dates) — never just paste links or one-line headlines.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            recency: {
              type: 'boolean',
              description: 'true for news / current events (uses the news index); false for general/evergreen topics'
            }
          },
          required: ['query']
        },
        sensitive: false
      },
      summary: (a) => String(a.query ?? ''),
      run: async (a) => {
        const query = String(a.query)
        const recency = a.recency === true
        // Fetchable article URLs come from DuckDuckGo (direct links). Google
        // News RSS links are redirect URLs that don't resolve to article text
        // over HTTP, so news_search is used only for DATED headline context.
        let web: SearchResult[] = []
        try {
          web = await ddgSearch(query)
        } catch {
          /* blocked — handled below */
        }
        let news: SearchResult[] = []
        if (recency) {
          try {
            news = await newsSearch(query)
          } catch {
            /* optional context */
          }
        }
        if (web.length === 0 && news.length === 0) {
          try {
            return (
              `Search results for "${query}":\n${await browser.search(query)}\n\n` +
              `---\nWrite a detailed answer from these; if they're thin, say so.`
            )
          } catch {
            return `Couldn't reach any search source for "${query}". Tell the user the search failed and offer to retry — do NOT invent facts.`
          }
        }

        // read the top direct sources in parallel (best-effort). Kept small so
        // the combined result fits a local model's context in ONE round (3+
        // large results overflow Ollama's 8192 window and it loops/truncates).
        const top = web.slice(0, 3)
        const fetched = await Promise.all(
          top.map(async (r) => ({ r, text: await fetchArticleText(r.url, 1600).catch(() => '') }))
        )

        const sections: string[] = []
        if (recency && news.length > 0) {
          const heads = news
            .slice(0, 6)
            .map((n) => `• ${n.title}${n.date || n.source ? ` (${[n.date, n.source].filter(Boolean).join(', ')})` : ''}`)
            .join('\n')
          sections.push(`Recent headlines:\n${heads}`)
        }
        const CAP = 4200
        let used = 0
        const readable = fetched.filter((f) => f.text || f.r.snippet)
        const blocks = readable.map(({ r, text }, i) => {
          const meta = [r.source, r.date].filter(Boolean).join(' · ')
          const budget = Math.max(500, Math.floor((CAP - used) / (readable.length - i)))
          const body = (text || r.snippet || '').slice(0, budget)
          used += body.length
          return `[${i + 1}] ${r.title}${meta ? ` (${meta})` : ''}\n${r.url}\n${body}`
        })
        if (blocks.length > 0) sections.push(`Sources read:\n\n${blocks.join('\n\n')}`)
        if (sections.length === 0) sections.push(formatResults(recency ? news : web))

        return (
          `Research on "${query}":\n\n${sections.join('\n\n')}\n\n` +
          `---\nThis is enough to answer — do NOT call research again. Now write a DETAILED, ` +
          `well-structured answer for the user synthesizing the above (name the sources and ` +
          `dates). Do not just list links or headlines, and do not invent details not in the sources.`
        )
      }
    },
    {
      def: {
        name: 'browser_goto',
        description: 'Open a URL in the headless browser session.',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url']
        },
        sensitive: false
      },
      summary: (a) => String(a.url ?? ''),
      run: (a) => browser.goto(String(a.url))
    },
    {
      def: {
        name: 'browser_read',
        description: 'Read the visible text of the current browser page.',
        inputSchema: { type: 'object', properties: {} },
        sensitive: false
      },
      summary: () => 'read page',
      run: () => browser.readText()
    },
    {
      def: {
        name: 'browser_inputs',
        description: 'List the form fields and buttons on the current page (for browser_type / browser_click targeting).',
        inputSchema: { type: 'object', properties: {} },
        sensitive: false
      },
      summary: () => 'inspect form fields',
      run: () => browser.listInputs()
    },
    {
      def: {
        name: 'browser_click',
        description: 'Click an element on the current page, by CSS selector or visible text.',
        inputSchema: {
          type: 'object',
          properties: { target: { type: 'string', description: 'CSS selector or visible text' } },
          required: ['target']
        },
        sensitive: true
      },
      summary: (a) => String(a.target ?? ''),
      run: (a) => browser.click(String(a.target))
    },
    {
      def: {
        name: 'browser_type',
        description:
          'Type text into a form field (by CSS selector, name, id, placeholder or label), optionally pressing Enter.',
        inputSchema: {
          type: 'object',
          properties: {
            field: { type: 'string' },
            text: { type: 'string' },
            pressEnter: { type: 'boolean' }
          },
          required: ['field', 'text']
        },
        sensitive: true
      },
      summary: (a) => `"${String(a.text ?? '').slice(0, 40)}" → ${String(a.field ?? '')}`,
      run: (a) => browser.type(String(a.field), String(a.text), Boolean(a.pressEnter))
    },
    {
      def: {
        name: 'browser_screenshot',
        description: 'Screenshot the current browser page to a PNG file.',
        inputSchema: { type: 'object', properties: {} },
        sensitive: false
      },
      summary: () => 'screenshot page',
      run: () => browser.screenshot()
    },
    {
      def: {
        name: 'browser_tabs',
        description: 'List the open tabs in the COSMOS browser (title + URL).',
        inputSchema: { type: 'object', properties: {} },
        sensitive: false
      },
      summary: () => 'list tabs',
      run: () => browser.listTabs()
    },
    {
      def: {
        name: 'browser_close_tab',
        description:
          'Close a specific tab in the COSMOS browser by name — a title or URL substring (e.g. "youtube", "gmail"). Use for "close the YouTube tab".',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'e.g. "youtube"' } },
          required: ['query']
        },
        sensitive: false
      },
      summary: (a) => String(a.query ?? ''),
      run: (a) => browser.closeTab(String(a.query))
    },
    {
      def: {
        name: 'browser_close',
        description: 'Close the entire COSMOS browser session (all tabs).',
        inputSchema: { type: 'object', properties: {} },
        sensitive: false
      },
      summary: () => 'close browser',
      run: async () => {
        await browser.close()
        return 'Browser closed.'
      }
    }
  ]
}
