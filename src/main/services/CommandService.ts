import { shell } from 'electron'
import { exec } from 'child_process'
import type { CommandResult, SystemCommandId } from '@shared/types'
import { AppLauncher } from './AppLauncher'

/**
 * Executes OS-level actions requested through the palette (and later,
 * assistant tool-use). Destructive commands are confirmed in the UI
 * before they ever reach this service — this is the execution layer,
 * the permission layer lives above it.
 */
export class CommandService {
  private readonly apps = new AppLauncher()

  get launcher(): AppLauncher {
    return this.apps
  }

  async run(id: SystemCommandId, arg?: string): Promise<CommandResult> {
    try {
      switch (id) {
        case 'open-url': {
          if (!arg || !/^https?:\/\//.test(arg)) return fail('Invalid URL')
          await shell.openExternal(arg)
          return ok()
        }
        case 'open-path': {
          if (!arg) return fail('Missing path')
          const err = await shell.openPath(arg)
          return err ? fail(err) : ok()
        }
        case 'open-app': {
          if (!arg) return fail('Missing app command')
          return await this.apps.launch(arg)
        }
        case 'close-app': {
          if (!arg) return fail('Missing app name')
          return await this.apps.close(arg)
        }
        case 'lock':
          return await this.shellExec('rundll32.exe user32.dll,LockWorkStation')
        case 'sleep':
          // SetSuspendState(Hibernate=false, Force=false, WakeEvents=false)
          return await this.shellExec(
            'powershell -NoProfile -Command "[void][System.Reflection.Assembly]::LoadWithPartialName(\'System.Windows.Forms\'); [System.Windows.Forms.Application]::SetSuspendState(\'Suspend\', $false, $false)"'
          )
        case 'restart':
          return await this.shellExec('shutdown /r /t 3 /c "COSMOS: restarting system"')
        case 'shutdown':
          return await this.shellExec('shutdown /s /t 3 /c "COSMOS: shutting down"')
        case 'shell-exec': {
          // plugin commands only; always behind the palette confirmation
          if (!arg) return fail('Missing command')
          return await this.shellExec(`powershell -NoProfile -Command "${arg.replace(/"/g, '\\"')}"`)
        }
        case 'empty-recycle-bin':
          return await this.shellExec(
            'powershell -NoProfile -Command "Clear-RecycleBin -Force -ErrorAction SilentlyContinue"'
          )
        default:
          return fail(`Unknown command: ${id as string}`)
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  }

  private shellExec(cmd: string): Promise<CommandResult> {
    return new Promise((resolve) => {
      exec(cmd, { windowsHide: true }, (err) => {
        resolve(err ? fail(err.message) : ok())
      })
    })
  }
}

const ok = (): CommandResult => ({ ok: true })
const fail = (message: string): CommandResult => ({ ok: false, message })
