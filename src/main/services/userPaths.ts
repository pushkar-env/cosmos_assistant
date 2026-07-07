import { app } from 'electron'
import { existsSync } from 'fs'
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

  if (isAbsolute(p)) return remapWrongUserHome(normalize(p))

  // leading known-folder segment → the real OS location (OneDrive-aware)
  const segs = p.split(/[\\/]+/)
  const first = segs[0]?.toLowerCase()
  const known = knownFolder(first)
  if (known) return normalize(join(known, ...segs.slice(1)))

  // otherwise treat as relative to HOME (never the install dir)
  return normalize(join(homedir(), p))
}

/**
 * Fixes a hallucinated home directory. Weaker models (esp. local Ollama
 * ones) see "the user's name is Pushkar" and build a path like
 * C:\Users\Pushkar\Desktop\… — but the real profile folder is
 * C:\Users\user. Creating anything under a non-existent C:\Users\<name>
 * fails with a permission error (Windows won't let you make new folders
 * directly under C:\Users). So: when an absolute path points at
 * C:\Users\<name>\… where <name> is NOT the real profile AND that folder
 * doesn't exist, re-root it at the real home — mapping a known subfolder
 * (Desktop/Documents/…) through the OS so OneDrive redirection is honored.
 */
function remapWrongUserHome(p: string): string {
  const m = /^([a-zA-Z]:[\\/]+Users[\\/]+)([^\\/]+)(?:[\\/]+(.*))?$/.exec(p)
  if (!m) return p
  const [, prefix, name, rest = ''] = m
  const home = homedir()
  const realName = home.split(/[\\/]/).filter(Boolean).pop() ?? ''
  // already the right user, or the guessed profile actually exists → leave it
  if (name.toLowerCase() === realName.toLowerCase()) return p
  if (existsSync(join(prefix, name))) return p

  const segs = rest.split(/[\\/]+/).filter(Boolean)
  const known = knownFolder(segs[0]?.toLowerCase())
  if (known) return normalize(join(known, ...segs.slice(1)))
  return normalize(join(home, ...segs))
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
