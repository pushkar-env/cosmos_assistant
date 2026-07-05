import { app } from 'electron'
import { homedir } from 'os'
import { isAbsolute, join, normalize } from 'path'

/**
 * Resolves a path the way a user means it, not the way `path.resolve`
 * does. Critically, relative paths resolve against the user's HOME, not
 * the process cwd — in a packaged build the cwd is the install dir
 * (often under Program Files), which is read-only and was the source of
 * "permission denied" when creating files. Also expands `~` and maps
 * well-known folder names (Desktop, Documents…) to their real
 * locations, which handles OneDrive redirection.
 */
export function resolveUserPath(input: string): string {
  let p = String(input).trim().replace(/^["']|["']$/g, '')

  // ~ or ~/... → home
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = join(homedir(), p.slice(1))
  }

  // %ENV% expansion (e.g. %USERPROFILE%, %APPDATA%)
  p = p.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? `%${name}%`)

  if (isAbsolute(p)) return normalize(p)

  // leading known-folder segment → the real OS location (OneDrive-aware)
  const segs = p.split(/[\\/]+/)
  const first = segs[0]?.toLowerCase()
  const known = knownFolder(first)
  if (known) return normalize(join(known, ...segs.slice(1)))

  // otherwise treat as relative to HOME (never the install dir)
  return normalize(join(homedir(), p))
}

function knownFolder(name: string | undefined): string | null {
  switch (name) {
    case 'desktop':
      return safeGetPath('desktop')
    case 'documents':
    case 'docs':
      return safeGetPath('documents')
    case 'downloads':
      return safeGetPath('downloads')
    case 'pictures':
      return safeGetPath('pictures')
    case 'music':
      return safeGetPath('music')
    case 'videos':
      return safeGetPath('videos')
    case 'home':
    case '~':
      return homedir()
    default:
      return null
  }
}

function safeGetPath(
  name: 'desktop' | 'documents' | 'downloads' | 'pictures' | 'music' | 'videos'
): string {
  try {
    return app.getPath(name)
  } catch {
    return join(homedir(), name.charAt(0).toUpperCase() + name.slice(1))
  }
}
