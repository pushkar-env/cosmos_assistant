import { execFile } from 'child_process'
import type { GitStatus, GithubIdentity } from '@shared/types'
import type { SettingsService } from './SettingsService'
import type { WorkspaceService } from './WorkspaceService'

const GH_API = 'https://api.github.com'
const UA = 'COSMOS-Assistant'

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number
}

/**
 * Git + GitHub for the assistant. Runs `git` directly (execFile, never the
 * streamed terminal) so the access token is NEVER echoed to the UI, and injects
 * auth as a scoped, in-memory http.extraheader (like GitHub Actions) so the
 * token is never written into .git/config or a remote URL. The token itself is
 * stored encrypted by SettingsService (safeStorage).
 */
export class GitService {
  constructor(
    private readonly settings: SettingsService,
    private readonly workspace: WorkspaceService
  ) {}

  // ── account ────────────────────────────────────────────────────────────────

  private token(): string {
    return this.settings.get().github.token
  }

  identity(): GithubIdentity | null {
    const g = this.settings.get().github
    return g.token && g.login ? { login: g.login, name: g.name, avatarUrl: g.avatarUrl } : null
  }

  /** validate a PAT against the GitHub API and store the connected identity */
  async connect(token: string): Promise<GithubIdentity> {
    const clean = token.trim()
    if (!clean) throw new Error('Enter a GitHub Personal Access Token.')
    const res = await fetch(`${GH_API}/user`, { headers: this.ghHeaders(clean) })
    if (res.status === 401) {
      throw new Error('That token was rejected (401). Check it hasn’t expired and has the "repo" scope.')
    }
    if (!res.ok) {
      throw new Error(`GitHub rejected the token (${res.status}). ${(await res.text()).slice(0, 120)}`)
    }
    const user = (await res.json()) as { login: string; name: string | null; id: number; avatar_url: string }
    const email = await this.resolveEmail(clean, user.id, user.login)
    // the renderer CSP blocks external images, so store the avatar as a data URL
    const avatarUrl = await this.avatarDataUrl(user.avatar_url)
    this.settings.set({
      github: {
        token: clean,
        login: user.login,
        name: user.name || user.login,
        email,
        avatarUrl
      }
    })
    return { login: user.login, name: user.name || user.login, avatarUrl }
  }

  /** fetch the avatar and inline it as a data: URL (CSP-safe) */
  private async avatarDataUrl(url: string): Promise<string> {
    try {
      const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}s=96`, {
        headers: { 'user-agent': UA }
      })
      if (!res.ok) return ''
      const type = res.headers.get('content-type') ?? 'image/png'
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > 400_000) return '' // keep settings small
      return `data:${type};base64,${buf.toString('base64')}`
    } catch {
      return ''
    }
  }

  disconnect(): void {
    this.settings.set({ github: { token: '', login: '', name: '', email: '', avatarUrl: '' } })
  }

  /** the account's primary verified email, or GitHub's noreply fallback */
  private async resolveEmail(token: string, id: number, login: string): Promise<string> {
    try {
      const res = await fetch(`${GH_API}/user/emails`, { headers: this.ghHeaders(token) })
      if (res.ok) {
        const emails = (await res.json()) as { email: string; primary: boolean; verified: boolean }[]
        const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified)
        if (primary) return primary.email
      }
    } catch {
      /* scope may not include user:email — fall through to noreply */
    }
    return `${id}+${login}@users.noreply.github.com`
  }

  private ghHeaders(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': UA
    }
  }

  /** create a repo on GitHub under the connected account */
  async createRepo(
    name: string,
    isPrivate: boolean,
    description?: string
  ): Promise<{ fullName: string; cloneUrl: string; htmlUrl: string }> {
    const token = this.token()
    if (!token) throw new Error('Connect a GitHub account first (Settings → GitHub).')
    const res = await fetch(`${GH_API}/user/repos`, {
      method: 'POST',
      headers: { ...this.ghHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ name, private: isPrivate, description: description ?? '', auto_init: false })
    })
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200)
      throw new Error(`Could not create the repo (${res.status}). ${detail}`)
    }
    const repo = (await res.json()) as { full_name: string; clone_url: string; html_url: string }
    return { fullName: repo.full_name, cloneUrl: repo.clone_url, htmlUrl: repo.html_url }
  }

  // ── git execution ────────────────────────────────────────────────────────

  /** the workspace root (default cwd) or a resolved subfolder */
  private async cwdFor(relPath?: string): Promise<string> {
    return relPath ? this.workspace.resolve(relPath) : this.workspace.getRoot()
  }

  /** run git; `auth:true` injects the token as a scoped, non-persisted header */
  private run(args: string[], cwd: string, auth = false): Promise<GitResult> {
    const full = auth ? [...this.authArgs(), ...args] : args
    return new Promise((resolve) => {
      execFile(
        'git',
        full,
        { cwd, windowsHide: true, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
          resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '', code })
        }
      )
    })
  }

  /** `-c http.https://github.com/.extraheader=…` — auth scoped to github.com */
  private authArgs(): string[] {
    const g = this.settings.get().github
    if (!g.token) return []
    const basic = Buffer.from(`${g.login || 'x-access-token'}:${g.token}`).toString('base64')
    return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`]
  }

  private out(r: GitResult): string {
    return [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n').trim()
  }

  /** git installed? (clear message when it isn't) */
  async ensureGit(): Promise<void> {
    const r = await this.run(['--version'], process.cwd())
    if (!r.ok) {
      throw new Error('Git is not installed or not on PATH. Install it from https://git-scm.com/download/win, then reopen COSMOS.')
    }
  }

  private async isRepo(cwd: string): Promise<boolean> {
    const r = await this.run(['rev-parse', '--is-inside-work-tree'], cwd)
    return r.ok && r.stdout.trim() === 'true'
  }

  // ── high-level operations (used by the git tools + Studio) ─────────────────

  async status(relPath?: string): Promise<GitStatus> {
    const cwd = await this.cwdFor(relPath)
    const empty: GitStatus = {
      isRepo: false,
      branch: '',
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      clean: true
    }
    if (!(await this.isRepo(cwd))) return empty
    const r = await this.run(['status', '--porcelain=v2', '--branch'], cwd)
    if (!r.ok) return empty
    const st: GitStatus = { ...empty, isRepo: true }
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith('# branch.head ')) st.branch = line.slice(14).trim()
      else if (line.startsWith('# branch.ab ')) {
        const m = /\+(\d+)\s+-(\d+)/.exec(line)
        if (m) {
          st.ahead = Number(m[1])
          st.behind = Number(m[2])
        }
      } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
        const xy = line.split(' ')[1] ?? '..'
        if (xy[0] !== '.') st.staged++
        if (xy[1] !== '.') st.unstaged++
      } else if (line.startsWith('u ')) {
        st.unstaged++
      } else if (line.startsWith('? ')) {
        st.untracked++
      }
    }
    st.clean = st.staged + st.unstaged + st.untracked === 0
    const remote = await this.run(['remote', 'get-url', 'origin'], cwd)
    if (remote.ok && remote.stdout.trim()) st.remote = remote.stdout.trim()
    return st
  }

  async statusText(relPath?: string): Promise<string> {
    const cwd = await this.cwdFor(relPath)
    if (!(await this.isRepo(cwd))) return 'Not a git repository. Use git_init or git_clone first.'
    return this.out(await this.run(['status'], cwd)) || 'Working tree clean.'
  }

  async init(relPath?: string): Promise<string> {
    const cwd = await this.cwdFor(relPath)
    const r = await this.run(['init', '-b', 'main'], cwd)
    return r.ok ? this.out(r) || `Initialized a git repository in ${cwd}` : this.out(r)
  }

  async diff(relPath: string | undefined, staged: boolean): Promise<string> {
    const cwd = await this.cwdFor(relPath)
    const r = await this.run(['diff', ...(staged ? ['--cached'] : []), '--stat', '-p'], cwd)
    const text = this.out(r)
    return text.length > 12_000 ? text.slice(0, 12_000) + '\n… [diff truncated]' : text || '(no changes)'
  }

  async log(relPath: string | undefined, n = 15): Promise<string> {
    const cwd = await this.cwdFor(relPath)
    const r = await this.run(['log', `-n${n}`, '--pretty=format:%h  %ad  %an  %s', '--date=short'], cwd)
    return this.out(r) || '(no commits yet)'
  }

  async commit(message: string, addAll: boolean, relPath?: string): Promise<string> {
    const cwd = await this.cwdFor(relPath)
    if (!(await this.isRepo(cwd))) {
      const init = await this.run(['init', '-b', 'main'], cwd)
      if (!init.ok) return `Could not initialize a repo: ${this.out(init)}`
    }
    if (addAll) {
      const add = await this.run(['add', '-A'], cwd)
      if (!add.ok) return `git add failed: ${this.out(add)}`
    }
    const g = this.settings.get().github
    const ident =
      g.login && g.email
        ? ['-c', `user.name=${g.name || g.login}`, '-c', `user.email=${g.email}`]
        : []
    const r = await this.run([...ident, 'commit', '-m', message], cwd)
    const text = this.out(r)
    if (!r.ok && /nothing to commit/i.test(text)) return 'Nothing to commit — the working tree is clean.'
    if (!r.ok && /Please tell me who you are|user\.email/i.test(text)) {
      return 'Commit failed: no git identity. Connect your GitHub account in Settings → GitHub, or set git user.name/user.email.'
    }
    return r.ok ? text || 'Committed.' : `Commit failed: ${text}`
  }

  async push(relPath: string | undefined, setUpstream: boolean): Promise<string> {
    const cwd = await this.cwdFor(relPath)
    if (!this.token()) {
      return 'Not connected to GitHub. Connect an account in Settings → GitHub (or add a Personal Access Token) so I can push.'
    }
    // current branch, so we can set upstream on the first push
    const br = await this.run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
    const branch = br.stdout.trim() || 'main'
    const args = setUpstream ? ['push', '-u', 'origin', branch] : ['push']
    const r = await this.run(args, cwd, true)
    const text = this.out(r)
    if (!r.ok && /no upstream|set-upstream|no configured push destination|'origin'/i.test(text)) {
      // retry with an explicit upstream when the branch has none yet
      const retry = await this.run(['push', '-u', 'origin', branch], cwd, true)
      return retry.ok ? this.out(retry) || 'Pushed.' : `Push failed: ${this.out(retry)}`
    }
    return r.ok ? text || 'Pushed.' : `Push failed: ${text}`
  }

  async pull(relPath?: string): Promise<string> {
    const cwd = await this.cwdFor(relPath)
    const r = await this.run(['pull'], cwd, true)
    return r.ok ? this.out(r) || 'Already up to date.' : `Pull failed: ${this.out(r)}`
  }

  async branch(action: 'list' | 'create' | 'switch', name?: string, relPath?: string): Promise<string> {
    const cwd = await this.cwdFor(relPath)
    if (action === 'list') return this.out(await this.run(['branch', '-a'], cwd)) || '(no branches)'
    if (!name) return 'Provide a branch name.'
    const args = action === 'create' ? ['checkout', '-b', name] : ['checkout', name]
    return this.out(await this.run(args, cwd)) || `Switched to ${name}.`
  }

  async setRemote(url: string, relPath?: string): Promise<string> {
    const cwd = await this.cwdFor(relPath)
    const has = await this.run(['remote', 'get-url', 'origin'], cwd)
    const args = has.ok ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url]
    const r = await this.run(args, cwd)
    return r.ok ? `origin → ${url}` : `Failed: ${this.out(r)}`
  }

  async clone(url: string, dirName?: string): Promise<string> {
    const root = await this.workspace.getRoot()
    const args = ['clone', url, ...(dirName ? [dirName] : [])]
    const r = await this.run(args, root, true)
    return r.ok ? this.out(r) || `Cloned into ${root}` : `Clone failed: ${this.out(r)}`
  }

  /** create a GitHub repo, wire it as origin, and (optionally) push */
  async publish(
    name: string,
    isPrivate: boolean,
    description: string | undefined,
    relPath?: string
  ): Promise<string> {
    const cwd = await this.cwdFor(relPath)
    if (!(await this.isRepo(cwd))) await this.run(['init', '-b', 'main'], cwd)
    const repo = await this.createRepo(name, isPrivate, description)
    await this.setRemote(repo.cloneUrl, relPath)
    // ensure there's at least one commit before pushing
    const log = await this.run(['rev-parse', 'HEAD'], cwd)
    if (!log.ok) {
      await this.run(['add', '-A'], cwd)
      const g = this.settings.get().github
      const ident = g.login && g.email ? ['-c', `user.name=${g.name || g.login}`, '-c', `user.email=${g.email}`] : []
      await this.run([...ident, 'commit', '-m', 'Initial commit'], cwd)
    }
    const push = await this.push(relPath, true)
    return `Created ${repo.htmlUrl} and pushed. ${push}`
  }
}
