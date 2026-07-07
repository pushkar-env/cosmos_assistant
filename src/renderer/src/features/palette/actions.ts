import type { ThemeId } from '@shared/types'
import { THEMES } from '@/core/theme/themes'
import { useSettingsStore } from '@/core/stores/useSettingsStore'
import { useAssistantStore } from '@/core/stores/useAssistantStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { useVoiceStore } from '@/features/voice/useVoiceStore'

import type { PluginManifest } from '@shared/types'

export type ActionSection = 'apps' | 'web' | 'system' | 'ai' | 'theme' | 'settings' | 'plugins'

export interface Action {
  id: string
  title: string
  subtitle?: string
  keywords: string[]
  section: ActionSection
  /** destructive — requires the confirmation flow */
  danger?: boolean
  run: () => void | Promise<void>
}

const cmd = window.cosmos.commands

/**
 * The single action registry. The palette renders it; later phases feed
 * the same registry to assistant tool-use and voice intents.
 */
export function buildActions(): Action[] {
  return [
    // ── apps ──
    {
      id: 'open-app-centre',
      title: 'Open App Centre',
      subtitle: 'Browse and launch every installed app',
      keywords: ['apps', 'app centre', 'app center', 'applications', 'programs', 'installed', 'launcher', 'games'],
      section: 'apps',
      run: () => useUIStore.getState().setPanel('apps')
    },
    app('notepad', 'Open Notepad', 'notepad'),
    app('calc', 'Open Calculator', 'calc'),
    app('explorer', 'Open File Explorer', 'explorer'),
    app('terminal', 'Open Terminal', 'wt'),
    app('vscode', 'Open VS Code', 'code'),
    app('taskmgr', 'Open Task Manager', 'taskmgr'),

    // ── web ──
    web('github', 'Open GitHub', 'https://github.com'),
    web('youtube', 'Open YouTube', 'https://youtube.com'),
    web('claude', 'Open Claude', 'https://claude.ai'),
    web('gmail', 'Open Gmail', 'https://mail.google.com'),

    // ── system ──
    {
      id: 'sys-lock',
      title: 'Lock PC',
      keywords: ['lock', 'secure', 'away'],
      section: 'system',
      run: () => void cmd.run('lock')
    },
    {
      id: 'sys-sleep',
      title: 'Sleep',
      keywords: ['sleep', 'suspend', 'rest'],
      section: 'system',
      run: () => void cmd.run('sleep')
    },
    {
      id: 'sys-restart',
      title: 'Restart System',
      subtitle: 'Restarts in 3 seconds',
      keywords: ['restart', 'reboot'],
      section: 'system',
      danger: true,
      run: () => void cmd.run('restart')
    },
    {
      id: 'sys-shutdown',
      title: 'Shut Down System',
      subtitle: 'Powers off in 3 seconds',
      keywords: ['shutdown', 'power', 'off'],
      section: 'system',
      danger: true,
      run: () => void cmd.run('shutdown')
    },
    {
      id: 'sys-recycle',
      title: 'Empty Recycle Bin',
      keywords: ['recycle', 'trash', 'empty', 'clean'],
      section: 'system',
      danger: true,
      run: () => void cmd.run('empty-recycle-bin')
    },

    // ── ai ──
    {
      id: 'ai-new-chat',
      title: 'New Chat',
      subtitle: 'Start a fresh conversation',
      keywords: ['new', 'chat', 'conversation', 'clear', 'reset', 'start'],
      section: 'ai',
      run: () => useAssistantStore.getState().clear()
    },
    {
      id: 'ai-clear-history',
      title: 'Clear All History',
      subtitle: 'Permanently delete every stored conversation',
      keywords: ['clear', 'delete', 'wipe', 'history', 'past', 'conversations', 'erase', 'forget chats'],
      section: 'ai',
      danger: true,
      run: () => void useAssistantStore.getState().clearAllHistory()
    },
    {
      id: 'ai-interrupt',
      title: 'Interrupt COSMOS',
      keywords: ['stop', 'interrupt', 'cancel', 'silence', 'shut up'],
      section: 'ai',
      run: () => useVoiceStore.getState().stopSpeech()
    },
    {
      id: 'voice-ptt',
      title: 'Speak to COSMOS',
      subtitle: 'Ctrl+J',
      keywords: ['voice', 'talk', 'speak', 'mic', 'microphone', 'listen', 'push to talk'],
      section: 'ai',
      run: () => void useVoiceStore.getState().togglePushToTalk()
    },
    {
      id: 'voice-handsfree',
      title: 'Toggle Hands-Free Mode',
      subtitle: 'Always listening for "Cosmos…"',
      keywords: ['voice', 'hands', 'free', 'wake', 'word', 'cosmos', 'always', 'listening'],
      section: 'ai',
      run: () => {
        const on = useVoiceStore.getState().micMode === 'handsfree'
        void useVoiceStore.getState().setHandsFree(!on)
      }
    },
    {
      id: 'voice-replies',
      title: 'Toggle Voice Replies',
      keywords: ['voice', 'replies', 'speech', 'tts', 'mute', 'speak'],
      section: 'ai',
      run: () => {
        const s = useSettingsStore.getState()
        void s.update({
          voice: { ...s.settings.voice, voiceReplies: !s.settings.voice.voiceReplies }
        })
      }
    },

    // ── themes ──
    ...(Object.keys(THEMES) as ThemeId[]).map(
      (id): Action => ({
        id: `theme-${id}`,
        title: `Theme: ${THEMES[id].label}`,
        keywords: ['theme', 'color', 'appearance', THEMES[id].label.toLowerCase()],
        section: 'theme',
        run: () => void useSettingsStore.getState().update({ theme: id })
      })
    ),

    // ── settings ──
    {
      id: 'open-settings',
      title: 'Open Settings',
      keywords: ['settings', 'preferences', 'config', 'api keys'],
      section: 'settings',
      run: () => useUIStore.getState().setPanel('settings')
    },
    {
      id: 'open-vault',
      title: 'Open Vault',
      subtitle: 'Memories · permissions · audit log',
      keywords: ['vault', 'memory', 'memories', 'remember', 'permissions', 'audit', 'log', 'trust'],
      section: 'settings',
      run: () => useUIStore.getState().setPanel('vault')
    },
    {
      id: 'open-dashboard',
      title: 'Open Dashboard',
      keywords: ['dashboard', 'overview', 'stats', 'today', 'home'],
      section: 'settings',
      run: () => useUIStore.getState().setPanel('dashboard')
    },
    {
      id: 'open-workspace',
      title: 'Open Workspace',
      subtitle: 'Notes shared with the agents',
      keywords: ['workspace', 'notes', 'note', 'editor', 'markdown', 'write'],
      section: 'settings',
      run: () => useUIStore.getState().setPanel('workspace')
    },
    {
      id: 'compact-mode',
      title: 'Toggle Compact Mode',
      subtitle: 'Floating always-on-top Cosmos',
      keywords: ['compact', 'mini', 'float', 'small', 'widget', 'always', 'top', 'pin'],
      section: 'settings',
      run: () => useUIStore.getState().toggleCompact()
    },
    {
      id: 'orb-mode',
      title: 'Shrink to Orb',
      subtitle: 'Floating round mic orb',
      keywords: ['orb', 'mic', 'round', 'icon', 'shrink', 'float', 'tiny', 'ball'],
      section: 'settings',
      run: () => useUIStore.getState().setMode('orb')
    },
    {
      id: 'hide-tray',
      title: 'Hide to Tray',
      subtitle: 'Keep running in the background',
      keywords: ['hide', 'tray', 'background', 'minimize', 'close'],
      section: 'settings',
      run: () => void window.cosmos.app.windowControl('close')
    },
    {
      id: 'quit-app',
      title: 'Quit COSMOS',
      subtitle: 'Fully exit (stops the background process)',
      keywords: ['quit', 'exit', 'close', 'kill', 'shut down cosmos'],
      section: 'settings',
      danger: true,
      run: () => void window.cosmos.app.quit()
    }
  ]
}

function app(id: string, title: string, exe: string): Action {
  return {
    id: `app-${id}`,
    title,
    keywords: ['open', 'launch', 'app', id, title.toLowerCase()],
    section: 'apps',
    run: () => void cmd.run('open-app', exe)
  }
}

function web(id: string, title: string, url: string): Action {
  return {
    id: `web-${id}`,
    title,
    subtitle: url,
    keywords: ['open', 'web', 'site', id, url],
    section: 'web',
    run: () => void cmd.run('open-url', url)
  }
}

/** Palette actions contributed by declarative plugins (docs/PLUGINS.md). */
export function pluginActions(manifests: PluginManifest[]): Action[] {
  return manifests.flatMap((m) =>
    m.commands.map(
      (c): Action => ({
        id: `plugin-${m.name}-${c.id}`,
        title: c.title,
        subtitle: `${m.name} · ${c.type === 'shell' ? c.target.slice(0, 60) : c.target}`,
        keywords: ['plugin', m.name.toLowerCase(), ...(c.keywords ?? [])],
        section: 'plugins',
        danger: c.type === 'shell', // arbitrary commands always confirm
        run: () => {
          if (c.type === 'url') void cmd.run('open-url', c.target)
          else if (c.type === 'app') void cmd.run('open-app', c.target)
          else void cmd.run('shell-exec', c.target)
        }
      })
    )
  )
}

/** Tiny fuzzy match: every query token must appear in the haystack. */
export function matches(action: Action, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = `${action.title} ${action.subtitle ?? ''} ${action.keywords.join(' ')}`.toLowerCase()
  return q.split(/\s+/).every((token) => haystack.includes(token))
}
