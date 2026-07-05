const BASE = 'http://127.0.0.1:30010'

/**
 * Unreal Engine via its built-in Remote Control API plugin (HTTP,
 * port 30010). The user enables the plugin in their project; Cosmos
 * gets engine status and console command execution. Blueprint/C++
 * work happens through the coder agent on the project files.
 */
export class UnrealService {
  async status(): Promise<string> {
    const res = await this.request('GET', '/remote/info')
    return res.slice(0, 2000)
  }

  async consoleCommand(command: string): Promise<string> {
    const res = await this.request(
      'PUT',
      '/remote/object/call',
      JSON.stringify({
        objectPath: '/Script/Engine.Default__KismetSystemLibrary',
        functionName: 'ExecuteConsoleCommand',
        parameters: { Command: command },
        generateTransaction: false
      })
    )
    return res.trim() ? res.slice(0, 2000) : `Executed console command: ${command}`
  }

  private async request(method: string, path: string, body?: string): Promise<string> {
    let res: Response
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body,
        signal: AbortSignal.timeout(15_000)
      })
    } catch {
      throw new Error(
        'Unreal Remote Control not reachable — enable the "Remote Control API" plugin and open your project'
      )
    }
    const text = await res.text()
    if (!res.ok) throw new Error(`Unreal API ${res.status}: ${text.slice(0, 300)}`)
    return text
  }
}
