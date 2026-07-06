/** Text utilities for the voice pipeline. */

// emoji / pictographic ranges — spoken engines mangle these, so drop them
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu

/** Strip markdown and other unspeakable syntax before TTS. */
export function toSpeakable(text: string): string {
  return (
    text
      .replace(/```[\s\S]*?```/g, ' Code block omitted. ') // fenced code
      .replace(/`([^`]+)`/g, '$1') // inline code → its text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images → nothing
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → link text only
      .replace(/https?:\/\/\S+/g, 'link') // bare URLs → "link"
      .replace(/^\s{0,3}#{1,6}\s+/gm, '') // heading markers
      .replace(/^\s*>\s?/gm, '') // blockquote markers
      .replace(/^\s*[-*+•]\s+/gm, '') // bullet list markers
      .replace(/^\s*\d+\.\s+/gm, '') // numbered list markers
      .replace(/^\s*\|.*\|\s*$/gm, ' ') // table rows
      .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1') // bold/italic/strike
      .replace(/[*_#>|`~]+/g, ' ') // any stray markers
      .replace(EMOJI_RE, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{2,}/g, '. ') // paragraph breaks → sentence pause
      .replace(/\n/g, ' ')
      .replace(/\s+([.,!?;:])/g, '$1') // tidy spacing before punctuation
      .replace(/([.!?])\s*\.+/g, '$1') // collapse doubled sentence-ends
      .replace(/\s+/g, ' ')
      .trim()
  )
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
