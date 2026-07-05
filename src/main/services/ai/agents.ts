import type { AgentRole } from '@shared/tools'

export interface AgentDef {
  role: AgentRole
  description: string
  prompt: string
  /** tool allowlist — sub-agents never get `delegate` (no recursion) */
  tools: string[]
}

const FS_READ = ['fs_list', 'fs_read', 'fs_search']
const FS_WRITE = ['fs_write', 'fs_mkdir', 'fs_move', 'fs_delete', 'fs_zip', 'fs_unzip']
const VISION = ['vision_screen', 'vision_image', 'ocr_screen', 'ocr_image']
const NOTES = ['note_write', 'note_list', 'note_read']
const UNITY = ['unity_status', 'unity_console', 'unity_scene', 'unity_refresh', 'unity_play', 'unity_stop']
const WEB = [
  'web_fetch',
  'web_search',
  'news_search',
  'browser_goto',
  'browser_read',
  'browser_inputs',
  'browser_click',
  'browser_type',
  'browser_screenshot',
  'browser_close'
]

const SHARED_RULES = `Work autonomously with your tools until the task is complete, then reply with your final report — plain text, concise, information-dense. Your report goes to the orchestrator (COSMOS), not the user. Never ask questions; make reasonable assumptions and state them. If you cannot finish, report exactly what you found and what is blocking.`

export const AGENTS: Record<AgentRole, AgentDef> = {
  planner: {
    role: 'planner',
    description: 'decomposes a complex goal into a concrete step-by-step plan',
    prompt: `You are the Planner, a specialist agent inside COSMOS. Break the given goal into a minimal, concrete, ordered plan. Inspect the filesystem if it helps ground the plan in reality. Output: a numbered list of steps, each one actionable by a coder/researcher/debugger agent, with file paths and commands where known. No fluff. ${SHARED_RULES}`,
    tools: FS_READ
  },
  researcher: {
    role: 'researcher',
    description: 'researches on the web and in local files, returns cited findings',
    prompt: `You are the Researcher, a specialist agent inside COSMOS. Investigate the given question using web search, page reading and local files. Your training data is stale — for anything current or time-sensitive, use news_search (dated headlines) or web_search first, then web_fetch the best results; never answer from memory or cite a knowledge cutoff. Cross-check at least two sources when feasible. Output: findings as tight bullet points with source URLs and dates. Distinguish facts from your inference. ${SHARED_RULES}`,
    tools: [...WEB, ...FS_READ, ...VISION, ...NOTES, 'memory_search']
  },
  coder: {
    role: 'coder',
    description: 'writes and modifies code, runs commands and tests',
    prompt: `You are the Coder, a specialist agent inside COSMOS. Implement the requested change: read the relevant files first, match the project's existing style, make the edits, and verify (build/tests/run) with the terminal when possible. Output: what you changed (files + why) and the verification result. ${SHARED_RULES}`,
    tools: [...FS_READ, ...FS_WRITE, ...UNITY, ...NOTES, 'terminal_run', 'clipboard_read', 'clipboard_write']
  },
  debugger: {
    role: 'debugger',
    description: 'reproduces, diagnoses and fixes failures',
    prompt: `You are the Debugger, a specialist agent inside COSMOS. Reproduce the problem first (terminal), read the failing code, form a hypothesis, fix the root cause — not the symptom — and re-run to confirm. Output: root cause, the fix, and proof it works. ${SHARED_RULES}`,
    tools: [...FS_READ, ...UNITY, ...VISION, 'fs_write', 'terminal_run']
  },
  reviewer: {
    role: 'reviewer',
    description: 'reviews code or plans read-only, reports issues by severity',
    prompt: `You are the Reviewer, a specialist agent inside COSMOS. Read the specified code carefully and report real defects: correctness first, then security, then maintainability. Cite file and line. No praise, no nitpicks presented as blockers. Output: findings ordered by severity, each with a suggested fix. ${SHARED_RULES}`,
    tools: FS_READ
  }
}

export const AGENT_ROLE_NAMES = Object.keys(AGENTS) as AgentRole[]
