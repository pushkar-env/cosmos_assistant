import { create } from 'zustand'
import type { AgentRole, AgentStatus } from '@shared/tools'

export interface ActiveAgent {
  agentId: string
  role: AgentRole
  status: AgentStatus
  task: string
}

interface AgentStore {
  agents: ActiveAgent[]
  init: () => void
}

const LINGER_MS = 3000
let initialized = false

/** Mirrors main-process agent events for the ring around the orb. */
export const useAgentStore = create<AgentStore>((set, get) => ({
  agents: [],

  init: () => {
    if (initialized) return
    initialized = true
    window.cosmos.tools.onAgentEvent(({ agentId, role, status, task }) => {
      const others = get().agents.filter((a) => a.agentId !== agentId)
      set({ agents: [...others, { agentId, role, status, task }] })
      if (status !== 'started') {
        // let the finished state show briefly, then clear the chip
        setTimeout(() => {
          set({ agents: get().agents.filter((a) => a.agentId !== agentId) })
        }, LINGER_MS)
      }
    })
  }
}))
