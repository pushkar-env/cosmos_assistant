import { app, dialog, shell, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, normalize } from 'path'
import type { SettingsService } from './SettingsService'

/**
 * Mirrors notes and research reports to real .md files in a user-chosen folder,
 * so they're openable, searchable and syncable outside COSMOS. The in-app Notes
 * list stays backed by the encrypted DB; this is an on-disk export kept in sync
 * on every save/delete. One file per note, named "<slug>-<id>.md" so a retitle
 * renames cleanly without leaving orphans.
 */
export class NotesExportService {
  constructor(private readonly settings: SettingsService) {}

  /** the effective notes folder, created on disk if missing */
  folder(): string {
    const configured = this.settings.get().notesFolder?.trim()
    const dir = configured && isAbsolute(configured) ? normalize(configured) : this.defaultFolder()
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* surfaced on first write */
    }
    return dir
  }

  private defaultFolder(): string {
    let docs: string
    try {
      docs = app.getPath('documents')
    } catch {
      docs = join(homedir(), 'Documents')
    }
    return join(docs, 'COSMOS Notes')
  }

  setFolder(dir: string): string {
    const folder = normalize(dir)
    mkdirSync(folder, { recursive: true })
    this.settings.set({ notesFolder: folder })
    return folder
  }

  async pick(win: BrowserWindow | null): Promise<string> {
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Choose where COSMOS saves notes & research reports',
      defaultPath: this.folder(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return this.folder()
    return this.setFolder(res.filePaths[0])
  }

  reveal(): void {
    const dir = this.folder()
    if (existsSync(dir)) shell.openPath(dir)
  }

  private slug(title: string): string {
    return (
      title
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 60) || 'note'
    )
  }

  /** write (or rewrite) a note's .md file, removing any prior file for this id */
  write(id: number, title: string, content: string): void {
    try {
      const dir = this.folder()
      // drop any earlier file for this id (title/slug may have changed)
      for (const name of readdirSync(dir)) {
        if (name.endsWith(`-${id}.md`)) {
          try {
            unlinkSync(join(dir, name))
          } catch {
            /* ignore */
          }
        }
      }
      // ensure the file carries a title heading even for plain notes
      const hasHeading = /^\s*#\s+/.test(content)
      const body = hasHeading ? content : `# ${title || 'Untitled'}\n\n${content}`
      writeFileSync(join(dir, `${this.slug(title)}-${id}.md`), body, 'utf-8')
    } catch (err) {
      console.error('[notes] export failed:', err)
    }
  }

  /** remove a note's .md file when it's deleted in-app */
  remove(id: number): void {
    try {
      const dir = this.folder()
      for (const name of readdirSync(dir)) {
        if (name.endsWith(`-${id}.md`)) {
          try {
            unlinkSync(join(dir, name))
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* folder may not exist yet — nothing to remove */
    }
  }
}
