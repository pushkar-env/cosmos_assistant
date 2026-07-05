import { promises as fs } from 'fs'
import { join } from 'path'
import { UNITY_BRIDGE_CSHARP, UNITY_BRIDGE_PORT } from './bridgeTemplate'

const BASE = `http://127.0.0.1:${UNITY_BRIDGE_PORT}`

/**
 * Talks to the CosmosBridge C# script running inside the Unity editor.
 * Script generation itself is plain fs_write into the project; this
 * service closes the loop: refresh assets, read the console, inspect
 * the scene, drive play mode.
 */
export class UnityService {
  async installBridge(projectPath: string): Promise<string> {
    const assets = join(projectPath, 'Assets')
    try {
      await fs.access(assets)
    } catch {
      throw new Error(`${projectPath} does not look like a Unity project (no Assets folder)`)
    }
    const editorDir = join(assets, 'Editor')
    await fs.mkdir(editorDir, { recursive: true })
    const file = join(editorDir, 'CosmosBridge.cs')
    await fs.writeFile(file, UNITY_BRIDGE_CSHARP, 'utf-8')
    return `Installed ${file}. Unity will compile it on next focus/refresh; then the bridge listens on port ${UNITY_BRIDGE_PORT}.`
  }

  async call(endpoint: string, param?: string): Promise<string> {
    const url =
      `${BASE}/${endpoint}` + (param ? `?item=${encodeURIComponent(param)}` : '')
    let res: Response
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    } catch {
      throw new Error(
        'Unity bridge not reachable — is the Unity editor open with CosmosBridge.cs installed? (unity_install_bridge)'
      )
    }
    const text = await res.text()
    if (text.startsWith('ERROR:')) throw new Error(text.slice(6).trim())
    return text
  }
}
