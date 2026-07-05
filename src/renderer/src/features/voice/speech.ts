/** Text utilities for the voice pipeline. */

/** Strip markdown and other unspeakable syntax before TTS. */
export function toSpeakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' Code block omitted. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/[*_#>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const WAKE_RE = /^\s*(?:hey|ok|okay|hi|yo)?[,\s]*(cosmos|kosmos|cosmo|cosmas)\b[,!.?\s]*/i

/**
 * Hands-free wake check: the utterance must address Cosmos.
 * Returns the command with the wake phrase stripped, or null.
 */
export function extractWakeCommand(transcript: string): string | null {
  const match = WAKE_RE.exec(transcript)
  if (!match) return null
  return transcript.slice(match[0].length).trim()
}

/**
 * Accumulates streaming deltas and emits complete sentences. The first
 * sentence is released early so speech starts fast; later ones batch a
 * little larger so playback sounds natural.
 */
export class SentenceChunker {
  private buffer = ''
  private emitted = 0

  constructor(private readonly emit: (sentence: string) => void) {}

  add(delta: string): void {
    this.buffer += delta
    const minLen = this.emitted === 0 ? 24 : 60

    for (;;) {
      const cut = this.findCut(minLen)
      if (cut === -1) break
      const sentence = this.buffer.slice(0, cut).trim()
      this.buffer = this.buffer.slice(cut)
      if (sentence) {
        this.emitted++
        this.emit(sentence)
      }
    }
  }

  flush(): void {
    const rest = this.buffer.trim()
    this.buffer = ''
    this.emitted = 0
    if (rest) this.emit(rest)
  }

  reset(): void {
    this.buffer = ''
    this.emitted = 0
  }

  private findCut(minLen: number): number {
    // never split inside an unclosed code fence — wait for it to close
    const fences = (this.buffer.match(/```/g) ?? []).length
    if (fences % 2 === 1) return -1

    const newline = this.buffer.indexOf('\n\n')
    if (newline >= minLen) return newline + 2

    const re = /[.!?…][)"']?(?:\s|$)/g
    let match: RegExpExecArray | null
    while ((match = re.exec(this.buffer)) !== null) {
      const end = match.index + match[0].length
      if (end >= minLen && end < this.buffer.length) return end
    }
    return -1
  }
}
