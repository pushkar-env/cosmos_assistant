import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { PluginCommand, PluginManifest } from '@shared/types'

/**
 * Declarative plugin loader (format v1, docs/PLUGINS.md). Each plugin
 * is a folder under userData/plugins containing a plugin.json manifest
 * that contributes palette commands. No plugin code executes — shell
 * commands run only through the palette's confirmation flow.
 */
export class PluginService {
  private manifests: PluginManifest[] = []

  get dir(): string {
    return join(app.getPath('userData'), 'plugins')
  }

  async load(): Promise<void> {
    this.manifests = []
    await fs.mkdir(this.dir, { recursive: true })
    let entries: string[] = []
    try {
      entries = await fs.readdir(this.dir)
    } catch {
      return
    }
    for (const entry of entries) {
      try {
        const raw = await fs.readFile(join(this.dir, entry, 'plugin.json'), 'utf-8')
        const manifest = JSON.parse(raw) as PluginManifest
        if (this.valid(manifest)) {
          this.manifests.push({ ...manifest, commands: manifest.commands.slice(0, 50) })
          console.log(`[plugins] loaded ${manifest.name}@${manifest.version} (${manifest.commands.length} commands)`)
        } else {
          console.warn(`[plugins] invalid manifest in ${entry}, skipped`)
        }
      } catch {
        /* not a plugin folder */
      }
    }
  }

  list(): PluginManifest[] {
    return this.manifests
  }

  private valid(m: PluginManifest): boolean {
    return (
      typeof m?.name === 'string' &&
      typeof m?.version === 'string' &&
      Array.isArray(m?.commands) &&
      m.commands.every(
        (c: PluginCommand) =>
          typeof c?.id === 'string' &&
          typeof c?.title === 'string' &&
          ['url', 'app', 'shell'].includes(c?.type) &&
          typeof c?.target === 'string'
      )
    )
  }
}
