import { clipboard, shell } from 'electron'
import { exec } from 'child_process'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { IPC } from '@shared/ipc'
import type { NotificationPayload } from '@shared/types'
import type { ToolSpec } from './ToolRegistry'
import { runPs } from './fileTools'
import { resolveUserPath } from '../userPaths'
import { captureScreenToFile } from '../screen'
import type { SystemStatsService } from '../SystemStatsService'
import type { CommandService } from '../CommandService'
import type { MediaService } from '../MediaService'

const MAX_TERMINAL_OUTPUT = 8_000

export function systemTools(
  stats: SystemStatsService,
  commands: CommandService,
  media: MediaService
): ToolSpec[] {
  return [
    {
      def: {
        name: 'terminal_run',
        description:
          'Run a PowerShell command and return its output. 30s timeout. Use for anything the other tools cannot do.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            cwd: { type: 'string', description: 'Working directory (optional)' }
          },
          required: ['command']
        },
        sensitive: true
      },
      summary: (a) => String(a.command ?? '').slice(0, 120),
      run: (a) =>
        new Promise((res) => {
          exec(
            String(a.command),
            {
              shell: 'powershell.exe',
              cwd: a.cwd ? String(a.cwd) : undefined,
              windowsHide: true,
              timeout: 30_000,
              maxBuffer: 4 * 1024 * 1024
            },
            (err, stdout, stderr) => {
              let out = [stdout, stderr].filter(Boolean).join('\n---stderr---\n').trim()
              if (out.length > MAX_TERMINAL_OUTPUT) {
                out = out.slice(0, MAX_TERMINAL_OUTPUT) + '\n… [output truncated]'
              }
              if (err && !out) out = err.message
              res(err ? `[exit error] ${out}` : out || '(no output)')
            }
          )
        })
    },
    {
      def: {
        name: 'notify',
        description:
          'Show the user a notification toast in the HUD. Use for proactive alerts, task completions, or anything worth surfacing outside the chat.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
            kind: { type: 'string', enum: ['info', 'success', 'error'] }
          },
          required: ['title', 'body']
        },
        sensitive: false
      },
      summary: (a) => String(a.title ?? ''),
      run: async (a, ctx) => {
        const payload: NotificationPayload = {
          title: String(a.title),
          body: String(a.body),
          kind: a.kind === 'success' || a.kind === 'error' ? a.kind : 'info'
        }
        if (!ctx.win.isDestroyed()) ctx.win.webContents.send(IPC.NOTIFY, payload)
        return 'Notification shown.'
      }
    },
    {
      def: {
        name: 'clipboard_read',
        description: 'Read the current clipboard text.',
        inputSchema: { type: 'object', properties: {} },
        sensitive: false
      },
      summary: () => 'read clipboard',
      run: async () => clipboard.readText() || '(clipboard is empty)'
    },
    {
      def: {
        name: 'clipboard_write',
        description: 'Copy text to the clipboard.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text']
        },
        sensitive: false
      },
      summary: (a) => `${String(a.text ?? '').slice(0, 60)}…`,
      run: async (a) => {
        clipboard.writeText(String(a.text))
        return 'Copied to clipboard.'
      }
    },
    {
      def: {
        name: 'screenshot',
        description: 'Capture the primary screen to a PNG file and return the saved path.',
        inputSchema: { type: 'object', properties: {} },
        sensitive: false
      },
      summary: () => 'capture screen',
      run: async () => `Saved screenshot: ${await captureScreenToFile()}`
    },
    {
      def: {
        name: 'app_open',
        description:
          'Launch ANY installed application or game by name — desktop apps ("Discord", "VS Code"), Store apps ("Calculator"), and games/launchers ("Apex Legends", "Steam", "Epic Games"). Uses the full Windows app list, so just pass the app name; it also accepts a full path. Try this directly before assuming something is not installed.',
        inputSchema: {
          type: 'object',
          properties: { target: { type: 'string' } },
          required: ['target']
        },
        sensitive: false
      },
      summary: (a) => String(a.target ?? ''),
      run: async (a) => {
        const result = await commands.run('open-app', String(a.target))
        if (!result.ok) throw new Error(result.message ?? 'Failed to launch')
        return result.message ?? `Launched ${String(a.target)}`
      }
    },
    {
      def: {
        name: 'app_close',
        description:
          'Close/quit a running application by name (e.g. "Steam", "Spotify", "Chrome"). Closes it GRACEFULLY by default (like clicking the window\'s X / File → Exit) so the app can save and clean up — this avoids leaving stale lock files that break the app\'s next launch. If the app stays open (e.g. an unsaved-changes prompt), the result says so; only set force:true when the user explicitly asks to "force close", "kill", or "force quit" it.',
        inputSchema: {
          type: 'object',
          properties: {
            target: { type: 'string' },
            force: {
              type: 'boolean',
              description: 'Hard-kill if it will not close gracefully. Only when the user explicitly asks to force/kill.'
            }
          },
          required: ['target']
        },
        sensitive: true
      },
      summary: (a) => `${String(a.target ?? '')}${a.force ? ' (force)' : ''}`,
      run: async (a) => {
        const result = await commands.launcher.close(String(a.target), a.force === true)
        if (!result.ok) throw new Error(result.message ?? 'Failed to close')
        return result.message ?? `Closed ${String(a.target)}`
      }
    },
    {
      def: {
        name: 'app_list',
        description:
          'List installed applications and games (the full Windows app list — desktop, Store, and games). Optional filter substring to narrow it (e.g. "adobe", "game"). Prefer calling app_open directly; use this only to browse or confirm a name.',
        inputSchema: {
          type: 'object',
          properties: { filter: { type: 'string' } }
        },
        sensitive: false
      },
      summary: (a) => (a.filter ? `filter: ${String(a.filter)}` : 'all apps'),
      run: async (a) => {
        const apps = await commands.launcher.listApps(a.filter ? String(a.filter) : undefined)
        return apps.length ? apps.join('\n') : 'No matching applications found.'
      }
    },
    {
      def: {
        name: 'play_youtube',
        description:
          'Play a song, video or track on YouTube. Resolves the query to the top matching video and opens it PLAYING in the user\'s real browser (with audio). Use this for any "play X", "play X by Y", "put on some music" request.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'e.g. "Believer by Imagine Dragons"' } },
          required: ['query']
        },
        sensitive: false
      },
      summary: (a) => String(a.query ?? ''),
      run: (a) => media.playYouTube(String(a.query))
    },
    {
      def: {
        name: 'media_control',
        description:
          'Control the currently playing media in the COSMOS player: pause, play, mute/unmute, skip forward/back, volume, restart, or stop. Use for "pause the song", "resume", "skip ahead", "turn it up", etc.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'play',
                'pause',
                'toggle',
                'mute',
                'unmute',
                'volume-up',
                'volume-down',
                'forward',
                'back',
                'restart',
                'stop'
              ]
            }
          },
          required: ['action']
        },
        sensitive: false
      },
      summary: (a) => String(a.action ?? ''),
      run: async (a) => {
        const action = String(a.action)
        return action === 'stop' ? media.stop() : media.control(action)
      }
    },
    {
      def: {
        name: 'url_open',
        description:
          'Open a web URL (http/https) in the default browser. For a LOCAL file or folder, prefer open_path — but this tool will also accept a local path or file:// URL and open it.',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url']
        },
        sensitive: false
      },
      summary: (a) => String(a.url ?? ''),
      run: async (a) => {
        const raw = String(a.url).trim()
        if (/^https?:\/\//i.test(raw)) {
          await shell.openExternal(raw)
          return `Opened ${raw}`
        }
        // tolerate a local file/folder or file:// URL — models often reach
        // for url_open to preview something they just created
        if (/^file:\/\//i.test(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || /[\\/]/.test(raw)) {
          const path = /^file:\/\//i.test(raw) ? fileURLToPath(raw) : raw
          const target = resolveUserPath(path)
          if (!existsSync(target)) throw new Error(`Nothing exists at ${target}`)
          const err = await shell.openPath(target)
          if (err) throw new Error(`Couldn't open ${target}: ${err}`)
          return `Opened ${target}`
        }
        throw new Error('Provide an http(s) URL, or a local file path (or use open_path)')
      }
    },
    {
      def: {
        name: 'system_stats',
        description: 'Get live system telemetry: CPU, GPU, RAM, network, battery, uptime.',
        inputSchema: { type: 'object', properties: {} },
        sensitive: false
      },
      summary: () => 'read telemetry',
      run: async () => JSON.stringify(await stats.snapshot(), null, 2)
    },
    {
      def: {
        name: 'volume',
        description: 'Adjust system volume: up/down by steps (each ≈2%), or toggle mute.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['up', 'down', 'mute'] },
            steps: { type: 'number', description: 'For up/down, default 5' }
          },
          required: ['action']
        },
        sensitive: false
      },
      summary: (a) => `${String(a.action ?? '')}${a.steps ? ` ×${Number(a.steps)}` : ''}`,
      run: async (a) => {
        const action = String(a.action)
        const steps = Math.min(Math.max(Number(a.steps) || 5, 1), 50)
        const key = action === 'mute' ? 173 : action === 'down' ? 174 : 175
        const count = action === 'mute' ? 1 : steps
        await runPs(
          `$w = New-Object -ComObject WScript.Shell; 1..${count} | ForEach-Object { $w.SendKeys([char]${key}) }`
        )
        return action === 'mute' ? 'Toggled mute.' : `Volume ${action} by ~${steps * 2}%.`
      }
    },
    {
      def: {
        name: 'power',
        description: 'Power actions: lock, sleep, restart, or shutdown the PC.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['lock', 'sleep', 'restart', 'shutdown'] }
          },
          required: ['action']
        },
        sensitive: true
      },
      summary: (a) => String(a.action ?? ''),
      run: async (a) => {
        const action = String(a.action) as 'lock' | 'sleep' | 'restart' | 'shutdown'
        if (!['lock', 'sleep', 'restart', 'shutdown'].includes(action)) {
          throw new Error(`Unknown power action: ${action}`)
        }
        const result = await commands.run(action)
        if (!result.ok) throw new Error(result.message ?? 'Power action failed')
        return `Executed: ${action}`
      }
    }
  ]
}
