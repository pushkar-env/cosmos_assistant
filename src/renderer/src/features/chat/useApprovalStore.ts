import { create } from 'zustand'
import type { ToolApprovalRequest } from '@shared/tools'
import type { ApprovalDecision } from '@shared/ipc'
import { sound } from '@/core/sound/SoundEngine'

interface ApprovalStore {
  queue: ToolApprovalRequest[]
  init: () => void
  respond: (approvalId: string, decision: ApprovalDecision) => void
}

let initialized = false

export const useApprovalStore = create<ApprovalStore>((set, get) => ({
  queue: [],

  init: () => {
    if (initialized) return
    initialized = true
    window.cosmos.tools.onApprovalRequest((req) => {
      sound.play('open')
      set({ queue: [...get().queue, req] })
    })
  },

  respond: (approvalId, decision) => {
    window.cosmos.tools.respondApproval(approvalId, decision)
    sound.play(decision === 'deny' ? 'close' : 'activate')
    set({ queue: get().queue.filter((r) => r.approvalId !== approvalId) })
  }
}))
