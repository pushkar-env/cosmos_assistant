import { create } from 'zustand'
import type { AssistantState, ChatMessage, ConversationMeta } from '@shared/types'
import { useSettingsStore } from './useSettingsStore'
import { sound } from '@/core/sound/SoundEngine'
import { voiceSignal } from '@/core/voice/voiceSignal'
import { useNotificationStore } from './useNotificationStore'

/** Streaming lifecycle events, consumed by the voice sentence-chunker. */
export type AssistantEvent =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error' }

type AssistantEventListener = (e: AssistantEvent) => void
const eventListeners = new Set<AssistantEventListener>()

export function subscribeAssistantEvents(cb: AssistantEventListener): () => void {
  eventListeners.add(cb)
  return () => eventListeners.delete(cb)
}

const notify = (e: AssistantEvent): void => eventListeners.forEach((cb) => cb(e))

export interface UIMessage extends ChatMessage {
  id: string
  error?: boolean
  /** tool-activity card rather than a chat bubble */
  tool?: {
    callId: string
    name: string
    status: 'running' | 'ok' | 'error' | 'denied'
    summary: string
    /** which specialist agent ran it (absent = COSMOS himself) */
    agent?: string
  }
}

/** how many past messages travel to the model as context */
const CONTEXT_WINDOW = 30

interface AssistantStore {
  state: AssistantState
  messages: UIMessage[]
  activeRequestId: string | null
  /** all saved chat sessions, most-recent first */
  sessions: ConversationMeta[]
  /** the session currently shown in the chat panel */
  currentSessionId: number | null
  init: () => void
  send: (text: string) => Promise<void>
  interrupt: () => void
  /** start a fresh chat (past conversations remain stored) */
  clear: () => void
  /** wipe every stored conversation from disk, then start fresh */
  clearAllHistory: () => Promise<void>
  setState: (state: AssistantState) => void
  /** reload the sessions list from disk */
  loadSessions: () => Promise<void>
  /** open a saved session by id */
  switchSession: (id: number) => Promise<void>
  /** delete a session; falls back to another (or a fresh one) */
  deleteSession: (id: number) => Promise<void>
  /** give a session a custom title */
  renameSession: (id: number, title: string) => Promise<void>
}

let initialized = false
let idCounter = 0
const nextId = (): string => `msg-${Date.now()}-${idCounter++}`

export const useAssistantStore = create<AssistantStore>((set, get) => ({
  state: 'idle',
  messages: [],
  activeRequestId: null,
  sessions: [],
  currentSessionId: null,

  init: () => {
    if (initialized) return
    initialized = true

    // restore the persisted conversation + the sessions list
    void window.cosmos.history.get().then((history) => {
      if (history.length && get().messages.length === 0) {
        set({
          messages: history.map((m) => ({ ...m, id: nextId() }))
        })
      }
    })
    void window.cosmos.sessions.active().then((id) => set({ currentSessionId: id }))
    void get().loadSessions()

    window.cosmos.tools.onEvent(({ requestId, callId, tool, status, summary, agent }) => {
      const messages = [...get().messages]

      if (status === 'running') {
        // only spawn a card for the request currently on screen
        if (requestId !== get().activeRequestId) return
        // close the current streaming bubble so tool cards keep
        // chronological order, then open a fresh bubble for what follows
        const last = messages[messages.length - 1]
        if (last?.role === 'assistant' && !last.tool && last.content === '') {
          messages.pop()
        }
        messages.push({
          id: nextId(),
          role: 'assistant',
          content: '',
          tool: { callId, name: tool, status, summary, agent }
        })
        messages.push({ id: nextId(), role: 'assistant', content: '' })
        set({ messages })
        return
      }

      // Completion (ok / error / denied): always resolve the matching card by
      // its unique callId — never gate on activeRequestId. A barge-in or an
      // early onDone nulls activeRequestId, and if the terminal event lands
      // after that the card would otherwise stay stuck spinning on "running".
      // Resolve the MOST-RECENT matching card (findLast) so that even if two
      // cards ever share a callId, the still-running one gets closed.
      const idx = messages.findLastIndex((m) => m.tool?.callId === callId)
      if (idx !== -1) {
        const card = messages[idx]
        messages[idx] = { ...card, tool: { ...card.tool!, status } }
        set({ messages })
      }
    })

    window.cosmos.ai.onToken(({ requestId, delta }) => {
      const { activeRequestId, messages, state } = get()
      if (requestId !== activeRequestId) return
      const last = messages[messages.length - 1]
      if (!last || last.role !== 'assistant' || last.tool) return
      // with voice replies the player owns the 'speaking' state — until
      // audio actually starts, streaming text is still "thinking"
      const voiceReplies = useSettingsStore.getState().settings.voice.voiceReplies
      if (!voiceReplies && state !== 'speaking') set({ state: 'speaking' })
      set({
        messages: [...messages.slice(0, -1), { ...last, content: last.content + delta }]
      })
      notify({ type: 'delta', text: delta })
    })

    window.cosmos.ai.onDone(({ requestId }) => {
      if (requestId !== get().activeRequestId) return
      // drop a trailing empty bubble (model ended on a tool call)
      const messages = [...get().messages]
      const last = messages[messages.length - 1]
      if (last?.role === 'assistant' && !last.tool && last.content === '') messages.pop()
      set({
        messages,
        activeRequestId: null,
        // if speech is mid-playback, the player will land us back on idle
        state: voiceSignal.speaking ? get().state : 'idle'
      })
      notify({ type: 'done' })
      sound.play('success')
      // the first message names the session; keep the list fresh
      void get().loadSessions()
    })

    window.cosmos.ai.onError(({ requestId, message }) => {
      const { activeRequestId, messages } = get()
      if (requestId !== activeRequestId) return
      const last = messages[messages.length - 1]
      const errored: UIMessage =
        last && last.role === 'assistant' && last.content === ''
          ? { ...last, content: message, error: true }
          : { id: nextId(), role: 'assistant', content: message, error: true }
      set({
        messages:
          last && last.role === 'assistant' && last.content === ''
            ? [...messages.slice(0, -1), errored]
            : [...messages, errored],
        state: 'idle',
        activeRequestId: null
      })
      notify({ type: 'error' })
      // the notification store plays the error sound
      useNotificationStore.getState().push({
        title: 'Request failed',
        body: message.slice(0, 140),
        kind: 'error'
      })
    })
  },

  send: async (text) => {
    const trimmed = text.trim()
    if (!trimmed) return
    // barge-in: a new message interrupts any in-flight response
    get().interrupt()

    const { settings } = useSettingsStore.getState()
    const requestId = nextId()
    const userMsg: UIMessage = { id: nextId(), role: 'user', content: trimmed }
    const assistantMsg: UIMessage = { id: nextId(), role: 'assistant', content: '' }

    const history: ChatMessage[] = [...get().messages, userMsg]
      .filter((m) => !m.error && !m.tool && m.content !== '')
      .map(({ role, content }) => ({ role, content }))
      .slice(-CONTEXT_WINDOW)

    set({
      messages: [...get().messages, userMsg, assistantMsg],
      state: 'thinking',
      activeRequestId: requestId
    })
    sound.play('activate')

    await window.cosmos.ai.chat({
      requestId,
      provider: settings.provider,
      model: settings.model,
      messages: history
    })
  },

  interrupt: () => {
    const { activeRequestId } = get()
    // abort the in-flight request if there is one, but ALWAYS land on idle —
    // Stop can also be pressed while merely speaking a finished reply (no
    // active request), and it must still reset the state so the button flips
    // back to "Send".
    if (activeRequestId) void window.cosmos.ai.abort(activeRequestId)
    set({ state: 'idle', activeRequestId: null })
    notify({ type: 'error' }) // clears any queued speech
  },

  clear: () => {
    get().interrupt()
    set({ messages: [] })
    void window.cosmos.history.new().then((id) => {
      set({ currentSessionId: id })
      void get().loadSessions()
    })
  },

  clearAllHistory: async () => {
    get().interrupt()
    set({ messages: [], sessions: [] })
    await window.cosmos.history.clearAll()
    await window.cosmos.sessions.active().then((id) => set({ currentSessionId: id }))
    await get().loadSessions()
  },

  setState: (state) => set({ state }),

  loadSessions: async () => {
    const sessions = await window.cosmos.sessions.list()
    set({ sessions })
  },

  switchSession: async (id) => {
    if (id === get().currentSessionId) return
    get().interrupt()
    const history = await window.cosmos.sessions.switch(id)
    set({
      currentSessionId: id,
      messages: history.map((m) => ({ ...m, id: nextId() }))
    })
  },

  deleteSession: async (id) => {
    const wasCurrent = id === get().currentSessionId
    if (wasCurrent) get().interrupt()
    const { activeId, messages } = await window.cosmos.sessions.delete(id)
    // only swap the visible transcript when the OPEN session was deleted
    if (wasCurrent) {
      set({ currentSessionId: activeId, messages: messages.map((m) => ({ ...m, id: nextId() })) })
    }
    await get().loadSessions()
  },

  renameSession: async (id, title) => {
    await window.cosmos.sessions.rename(id, title)
    await get().loadSessions()
  }
}))
