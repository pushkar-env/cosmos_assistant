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
      .replace(/^(\s*(?:[-*+•]|\d+[.)])\s+[^\n]*[^\s.!?,;:…])$/gm, '$1.') // list items end like sentences
      .replace(/^\s*[-*+•]\s+/gm, '') // bullet list markers
      .replace(/^\s*\d+\.\s+/gm, '') // numbered list markers
      .replace(/^\s*\|.*\|\s*$/gm, ' ') // table rows
      .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1') // bold/italic/strike
      .replace(/[*_#>|`~]+/g, ' ') // any stray markers
      .replace(EMOJI_RE, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{2,}/g, '. ') // paragraph breaks → sentence pause
      .replace(/([^\s.!?,;:…—–-])\n/g, '$1,\n') // unpunctuated line ends → brief comma pause
      .replace(/\n/g, ' ')
      .replace(/\s+([.,!?;:])/g, '$1') // tidy spacing before punctuation
      .replace(/([.!?])\s*\.+/g, '$1') // collapse doubled sentence-ends
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/** What kind of break ended a speech chunk — drives the pause after it. */
export type ChunkBoundary = 'paragraph' | 'line' | 'sentence' | 'flush'

/**
 * Silence to insert after a chunk, in ms, modeled on human pacing:
 * paragraphs get a full breath, headings announce and settle, questions
 * hang slightly longer than statements, commas barely register. Longer
 * sentences earn a longer breath, and ±15% jitter keeps the rhythm from
 * sounding metronomic.
 */
export function pauseAfterMs(raw: string, boundary: ChunkBoundary): number {
  const text = raw.trimEnd()
  let base: number
  if (boundary === 'paragraph') base = 650
  else if (/^\s{0,3}#{1,6}\s/.test(raw)) base = 550
  else if (boundary === 'line') base = 320
  else base = punctuationPause(text)
  const words = text.split(/\s+/).length
  const scaled = base + Math.min(150, words * 5)
  return Math.round(scaled * (0.85 + Math.random() * 0.3))
}

function punctuationPause(text: string): number {
  const bare = text.replace(/["')\]]+$/, '')
  if (bare.endsWith('...') || bare.endsWith('…')) return 600 // trailing off
  switch (bare.slice(-1)) {
    case '?':
      return 480
    case '!':
      return 410
    case '.':
      return 360
    case ':':
      return 300
    case ';':
      return 280
    case ',':
      return 190
    default:
      return 240 // cut mid-thought (flush) — just a beat
  }
}

const LIST_ITEM_RE = /^\s*(?:[-*+•]|\d+[.)])\s/

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

/** the "Yes?" prompt echoing back into the mic — ignore these as follow-ups */
const ECHO_RE = /^(yes|yeah|yep|ok|okay)[.!?]?$/i

export type HandsFreeAction =
  | { kind: 'ignore' }
  | { kind: 'prompt' } // bare "Cosmos" → answer "Yes?" and open a follow-up window
  | { kind: 'command'; text: string }

/**
 * Decide what a hands-free transcript means. `inFollowUp` is true when we just
 * answered a bare "Cosmos" with "Yes?" — in that window the next utterance is
 * the command even without the wake word (the VAD usually splits "Cosmos …
 * command" into two segments). The "Yes?" echo is ignored so it doesn't get
 * mistaken for the command.
 */
export function resolveHandsFree(transcript: string, inFollowUp: boolean): HandsFreeAction {
  const wake = extractWakeCommand(transcript)
  if (wake === null) {
    if (!inFollowUp) return { kind: 'ignore' }
    const t = transcript.trim()
    if (!t || ECHO_RE.test(t)) return { kind: 'ignore' } // echo/empty → keep waiting
    return { kind: 'command', text: t }
  }
  return wake ? { kind: 'command', text: wake } : { kind: 'prompt' }
}

/**
 * Accumulates streaming deltas and emits complete sentences. The first
 * sentence is released early so speech starts fast; later ones batch a
 * little larger so playback sounds natural.
 */
export class SentenceChunker {
  private buffer = ''
  private emitted = 0

  constructor(private readonly emit: (sentence: string, boundary: ChunkBoundary) => void) {}

  add(delta: string): void {
    this.buffer += delta
    const minLen = this.emitted === 0 ? 24 : 60

    for (;;) {
      const cut = this.findCut(minLen)
      if (!cut) break
      const sentence = this.buffer.slice(0, cut.at).trim()
      this.buffer = this.buffer.slice(cut.at)
      if (sentence) {
        this.emitted++
        this.emit(sentence, cut.boundary)
      }
    }
  }

  flush(): void {
    const rest = this.buffer.trim()
    this.buffer = ''
    this.emitted = 0
    if (rest) this.emit(rest, 'flush')
  }

  reset(): void {
    this.buffer = ''
    this.emitted = 0
  }

  private findCut(minLen: number): { at: number; boundary: ChunkBoundary } | null {
    // never split inside an unclosed code fence — wait for it to close
    const fences = (this.buffer.match(/```/g) ?? []).length
    if (fences % 2 === 1) return null

    // line breaks are the strongest pause signal: \n\n is a paragraph,
    // a single \n a list item or heading line
    const nl = /\n/g
    let brk: RegExpExecArray | null
    while ((brk = nl.exec(this.buffer)) !== null) {
      // a run touching the buffer's end may still be growing — wait for
      // the next delta to learn whether this is \n or \n\n
      const next = this.buffer[brk.index + 1]
      if (next === undefined) break
      // paragraphs and completed list items are always their own chunks —
      // batching them makes distinct thoughts read as one continuous run
      const lineStart = this.buffer.lastIndexOf('\n', brk.index - 1) + 1
      const isListItem = LIST_ITEM_RE.test(this.buffer.slice(lineStart, brk.index))
      const isParagraph = next === '\n'
      if (brk.index < (isListItem || isParagraph ? 12 : minLen)) continue
      if (isParagraph) return { at: brk.index + 2, boundary: 'paragraph' }
      return { at: brk.index + 1, boundary: 'line' }
    }

    const re = /[.!?…][)"']?(?:\s|$)/g
    let match: RegExpExecArray | null
    while ((match = re.exec(this.buffer)) !== null) {
      const end = match.index + match[0].length
      if (end < minLen || end >= this.buffer.length) continue
      // never split inside a list item — it stays whole until its
      // newline arrives and the line cut above takes it as one chunk
      const lineStart = this.buffer.lastIndexOf('\n', match.index) + 1
      if (LIST_ITEM_RE.test(this.buffer.slice(lineStart, match.index))) continue
      return { at: end, boundary: 'sentence' }
    }

    // nothing spoken yet: cut at the first clause boundary so audio can
    // start while the rest of the sentence is still streaming in
    if (this.emitted === 0) {
      const clause = /[,;:—–][)"']?\s/g
      let cm: RegExpExecArray | null
      while ((cm = clause.exec(this.buffer)) !== null) {
        const end = cm.index + cm[0].length
        if (end < 12 || end >= this.buffer.length) continue
        const lineStart = this.buffer.lastIndexOf('\n', cm.index) + 1
        if (LIST_ITEM_RE.test(this.buffer.slice(lineStart, cm.index))) continue
        return { at: end, boundary: 'sentence' }
      }
    }
    return null
  }
}
