import { create } from 'zustand'

/*
 * The thin seam between the app and the avatar's stage: the chat store calls
 * in here (a message arrived, "start a new chat"), and the avatar — when one
 * is on screen — answers. No three.js on this side, so importing it costs
 * nothing.
 */

export interface StageHandler {
  /** the user just sent something: if she's off playing, she comes back */
  userMessage(): void
  /** walk over and press "New". Resolves true once the chat was cleared by
   *  her (false: she can't — no avatar, panel open… — so the caller should) */
  newChat(): Promise<boolean>
  /** could she go and press New right now? */
  canAct(): boolean
  /** start a play session now (true if she started) */
  playNow(): boolean
  /** the user grabbed a card she may be holding */
  userGrabbed(id: string): void
}

let handler: StageHandler | null = null

export const stageBridge = {
  attach(h: StageHandler): () => void {
    handler = h
    return () => {
      if (handler === h) handler = null
    }
  },
  userMessage(): void {
    handler?.userMessage()
  },
  newChat(): Promise<boolean> {
    return handler ? handler.newChat() : Promise.resolve(false)
  },
  canAct(): boolean {
    return handler?.canAct() ?? false
  },
  playNow(): boolean {
    return handler?.playNow() ?? false
  },
  userGrabbed(id: string): void {
    handler?.userGrabbed(id)
  }
}

/** her world's clock rate (a dev/testing aid: 0.25 = quarter speed) */
export const stageClock = { scale: 1 }

interface StageState {
  /** she's up and about: her canvas sits above the HUD and the camera holds still */
  acting: boolean
  setActing: (on: boolean) => void
}

export const useStageStore = create<StageState>((set) => ({
  acting: false,
  setActing: (acting) => set({ acting })
}))
