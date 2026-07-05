import { promises as fs } from 'fs'
import { resolve } from 'path'
import type { ToolSpec } from './ToolRegistry'
import { captureScreenPng, captureScreenToFile } from '../screen'
import type { VisionService } from '../VisionService'
import type { OcrService } from '../OcrService'
import type { UnityService } from '../unity/UnityService'
import type { UnrealService } from '../UnrealService'

interface CreatorServices {
  vision: VisionService
  ocr: OcrService
  unity: UnityService
  unreal: UnrealService
}

export function creatorTools({ vision, ocr, unity, unreal }: CreatorServices): ToolSpec[] {
  return [
    // ── vision ──
    {
      def: {
        name: 'vision_screen',
        description:
          'Look at the screen: capture the primary display and answer a question about it with the vision model (describe UI, find buttons, explain errors, read anything).',
        inputSchema: {
          type: 'object',
          properties: { question: { type: 'string', description: 'What to look for or explain' } },
          required: ['question']
        },
        sensitive: false
      },
      summary: (a) => String(a.question ?? '').slice(0, 90),
      run: async (a) => {
        const png = await captureScreenPng()
        return vision.analyze(png.toString('base64'), String(a.question))
      }
    },
    {
      def: {
        name: 'vision_image',
        description: 'Analyze an image file (PNG/JPG) with the vision model and answer a question about it.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            question: { type: 'string' }
          },
          required: ['path', 'question']
        },
        sensitive: false
      },
      summary: (a) => `${String(a.path ?? '')} — ${String(a.question ?? '').slice(0, 50)}`,
      run: async (a) => {
        const buf = await fs.readFile(resolve(String(a.path)))
        if (buf.length > 8 * 1024 * 1024) throw new Error('Image too large (max 8 MB)')
        return vision.analyze(buf.toString('base64'), String(a.question))
      }
    },
    // ── OCR (offline, Windows built-in engine) ──
    {
      def: {
        name: 'ocr_screen',
        description: 'Extract all text from the current screen using offline OCR (no AI call, exact text).',
        inputSchema: { type: 'object', properties: {} },
        sensitive: false
      },
      summary: () => 'read screen text',
      run: async () => {
        const file = await captureScreenToFile('ocr')
        return ocr.recognize(file)
      }
    },
    {
      def: {
        name: 'ocr_image',
        description: 'Extract text from an image file using offline OCR.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path']
        },
        sensitive: false
      },
      summary: (a) => String(a.path ?? ''),
      run: (a) => ocr.recognize(resolve(String(a.path)))
    },
    // ── Unity ──
    {
      def: {
        name: 'unity_install_bridge',
        description:
          'Install the COSMOS editor bridge (CosmosBridge.cs) into a Unity project so unity_* tools work. Writes to Assets/Editor.',
        inputSchema: {
          type: 'object',
          properties: { projectPath: { type: 'string', description: 'Unity project root' } },
          required: ['projectPath']
        },
        sensitive: true
      },
      summary: (a) => String(a.projectPath ?? ''),
      run: (a) => unity.installBridge(String(a.projectPath))
    },
    {
      def: {
        name: 'unity_status',
        description: 'Ping the Unity editor bridge: project name, Unity version, play state.',
        inputSchema: { type: 'object', properties: {} },
        sensitive: false
      },
      summary: () => 'ping editor',
      run: () => unity.call('ping')
    },
    {
      def: {
        name: 'unity_console',
        description: 'Read the Unity editor console (recent logs, warnings, compile errors).',
        inputSchema: { type: 'object', properties: {} },
        sensitive: false
      },
      summary: () => 'read console',
      run: () => unity.call('console')
    },
    {
      def: {
        name: 'unity_scene',
        description: 'Dump the active Unity scene hierarchy with components.',
        inputSchema: { type: 'object', properties: {} },
        sensitive: false
      },
      summary: () => 'inspect scene',
      run: () => unity.call('scene')
    },
    {
      def: {
        name: 'unity_refresh',
        description: 'Refresh the Unity asset database (triggers script recompilation after edits — check unity_console for errors after).',
        inputSchema: { type: 'object', properties: {} },
        sensitive: false
      },
      summary: () => 'refresh assets',
      run: () => unity.call('refresh')
    },
    {
      def: {
        name: 'unity_play',
        description: 'Enter play mode in the Unity editor.',
        inputSchema: { type: 'object', properties: {} },
        sensitive: false
      },
      summary: () => 'enter play mode',
      run: () => unity.call('play')
    },
    {
      def: {
        name: 'unity_stop',
        description: 'Exit play mode in the Unity editor.',
        inputSchema: { type: 'object', properties: {} },
        sensitive: false
      },
      summary: () => 'exit play mode',
      run: () => unity.call('stop')
    },
    {
      def: {
        name: 'unity_menu',
        description:
          'Execute a Unity editor menu item by path, e.g. "File/Save Project" or "Window/General/Console". Powerful — includes builds.',
        inputSchema: {
          type: 'object',
          properties: { item: { type: 'string' } },
          required: ['item']
        },
        sensitive: true
      },
      summary: (a) => String(a.item ?? ''),
      run: (a) => unity.call('menu', String(a.item))
    },
    // ── Unreal ──
    {
      def: {
        name: 'unreal_status',
        description: 'Check the Unreal Engine Remote Control API (requires the plugin enabled in the project).',
        inputSchema: { type: 'object', properties: {} },
        sensitive: false
      },
      summary: () => 'ping engine',
      run: () => unreal.status()
    },
    {
      def: {
        name: 'unreal_command',
        description: 'Run an Unreal console command (e.g. "stat fps", "t.MaxFPS 120", "obj list class=StaticMesh").',
        inputSchema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command']
        },
        sensitive: true
      },
      summary: (a) => String(a.command ?? ''),
      run: (a) => unreal.consoleCommand(String(a.command))
    }
  ]
}
