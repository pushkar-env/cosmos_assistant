import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { promises as fs } from 'fs'
import { extname, isAbsolute, join, normalize, relative } from 'path'
import type { WorkspaceService } from './WorkspaceService'

/** minimal content-type table for the files a static site/game actually serves */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8'
}

function mimeFor(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

const NOT_FOUND_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Not found</title>
<style>html{background:#0b0b12;color:#8b8ba7;font:14px/1.6 system-ui,sans-serif;height:100%}
body{height:100%;margin:0;display:grid;place-items:center;text-align:center;padding:2rem}
code{color:#c9a2ff}</style></head><body><div>
<p style="font-size:12px;letter-spacing:.3em;text-transform:uppercase;color:#c9a2ff">COSMOS Preview</p>
<p>Nothing to serve here yet.</p>
<p>Build a page (an <code>index.html</code>) in this folder, then hit Reload.</p>
</div></body></html>`

/**
 * A tiny read-only static file server rooted at the current Studio workspace.
 * It lets the preview pane (and the real browser) load a plain HTML game/app
 * over http:// — which, unlike file://, makes ES modules, fetch(), and relative
 * asset paths work exactly as they would when deployed. The root is resolved
 * per-request from the WorkspaceService, so it always follows the active
 * workspace without needing a restart when the user picks a new folder.
 */
export class PreviewServer {
  private server: Server | null = null
  private port = 0
  private starting: Promise<string> | null = null

  constructor(private readonly workspace: WorkspaceService) {}

  /** start the server (once) and return its base URL, e.g. http://127.0.0.1:5123 */
  ensureStarted(): Promise<string> {
    if (this.server && this.port) return Promise.resolve(this.baseUrl())
    if (this.starting) return this.starting
    this.starting = new Promise<string>((resolve, reject) => {
      const srv = createServer((req, res) => void this.handle(req, res))
      srv.on('error', (err) => {
        this.starting = null
        reject(err)
      })
      // port 0 → OS picks a free ephemeral port; bind to loopback only
      srv.listen(0, '127.0.0.1', () => {
        this.server = srv
        const addr = srv.address()
        this.port = typeof addr === 'object' && addr ? addr.port : 0
        resolve(this.baseUrl())
      })
    })
    return this.starting
  }

  private baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /**
   * URL that serves `relPath` (a workspace-relative path). With no path it
   * serves the workspace index. Each segment is encoded so spaces/# in file
   * names don't break the URL.
   */
  async urlFor(relPath?: string): Promise<string> {
    await this.ensureStarted()
    if (!relPath) return `${this.baseUrl()}/`
    const encoded = relPath
      .split(/[\\/]+/)
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/')
    return `${this.baseUrl()}/${encoded}`
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const root = await this.workspace.getRoot()
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
      const rel = urlPath.replace(/^\/+/, '')
      let abs = normalize(join(root, rel))

      // never let a crafted path (../../) escape the workspace
      const rootRel = relative(root, abs)
      if (rootRel.startsWith('..') || isAbsolute(rootRel)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        res.end('Forbidden')
        return
      }

      let stat = await fs.stat(abs).catch(() => null)
      if (stat?.isDirectory()) {
        abs = join(abs, 'index.html')
        stat = await fs.stat(abs).catch(() => null)
      }
      if (!stat?.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(NOT_FOUND_HTML)
        return
      }

      const data = await fs.readFile(abs)
      res.writeHead(200, {
        'Content-Type': mimeFor(abs),
        // always revalidate so edits show up on Reload, never a stale cache
        'Cache-Control': 'no-store'
      })
      res.end(data)
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(err instanceof Error ? err.message : String(err))
    }
  }

  dispose(): void {
    this.server?.close()
    this.server = null
    this.port = 0
    this.starting = null
  }
}
