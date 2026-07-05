import { create } from 'zustand'
import type { NotificationPayload } from '@shared/types'
import { sound } from '@/core/sound/SoundEngine'

export interface AppNotification extends NotificationPayload {
  id: number
  ts: number
  read: boolean
  /** still visible as a toast */
  toast: boolean
}

interface NotificationStore {
  items: AppNotification[]
  centerOpen: boolean
  init: () => void
  push: (n: NotificationPayload) => void
  dismissToast: (id: number) => void
  toggleCenter: (open?: boolean) => void
  clear: () => void
}

const TOAST_MS = 6000
const KEEP = 50
let counter = 0
let initialized = false

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  items: [],
  centerOpen: false,

  init: () => {
    if (initialized) return
    initialized = true
    window.cosmos.app.onNotify((n) => get().push(n))
  },

  push: (n) => {
    const item: AppNotification = { ...n, id: ++counter, ts: Date.now(), read: false, toast: true }
    set({ items: [item, ...get().items].slice(0, KEEP) })
    sound.play(n.kind === 'error' ? 'error' : 'open')
    setTimeout(() => get().dismissToast(item.id), TOAST_MS)
  },

  dismissToast: (id) => {
    set({ items: get().items.map((i) => (i.id === id ? { ...i, toast: false } : i)) })
  },

  toggleCenter: (open) => {
    const next = open ?? !get().centerOpen
    set({
      centerOpen: next,
      // opening the center marks everything read
      items: next ? get().items.map((i) => ({ ...i, read: true })) : get().items
    })
  },

  clear: () => set({ items: [], centerOpen: false })
}))
