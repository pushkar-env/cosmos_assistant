/*
 * Conversation → emotion.
 *
 * A small, fast lexicon reader (no model call, no latency) that scores a
 * sentence for the feelings Nova can show. It reads the user's message (to
 * react the moment you speak to her) and each sentence of her reply as it
 * streams, so her face follows what she is actually saying.
 */

export type Emotion =
  | 'neutral'
  | 'happy'
  | 'joy'
  | 'excited'
  | 'sad'
  | 'surprised'
  | 'angry'
  | 'thinking'
  | 'shy'
  | 'relaxed'

export type Gesture =
  | 'Wave'
  | 'Nod'
  | 'Happy'
  | 'Bow'
  | 'Surprised'
  | 'Shy'
  | 'Explain'
  | 'Stretch'

export interface Reading {
  emotion: Emotion
  /** 0..1 */
  intensity: number
  gesture?: Gesture
}

const LEX: [Emotion, RegExp, number][] = [
  ['joy', /\b(haha+|hehe+|lol|yay+|hooray|woo+hoo|love (it|that|this)|so happy|delighted)\b|😂|🤣|😆|🥳/i, 1.0],
  ['excited', /\b(amazing|incredible|awesome|fantastic|exciting|can'?t wait|brilliant|epic|wow+)\b|🎉|✨|🚀|🔥|!!/i, 0.9],
  ['happy', /\b(great|glad|happy|nice|good news|wonderful|perfect|excellent|enjoy|congrat\w*|welcome|pleasure|sure thing|of course|absolutely|done|success\w*|fixed)\b|😊|😄|🙂|❤️|💖|👍/i, 0.7],
  ['sad', /\b(sorry|unfortunately|sadly|sad|regret|apolog\w*|i'?m afraid|couldn'?t|can'?t|unable|failed|failure|lost|miss(ed)?|tough|difficult time|condolence\w*)\b|😢|😭|😞|💔/i, 0.75],
  ['surprised', /\b(whoa|oh+!|really\?|no way|surprising(ly)?|unexpected(ly)?|what\?!|seriously\?|huh\?)\b|😮|😲|🤯|😳/i, 0.8],
  ['angry', /\b(annoying|annoyed|angry|furious|frustrat\w*|ugh+|hate|stupid|terrible|awful|rude|nothing works|(doesn'?t|does not|won'?t) work|not working|broken)\b|😠|😡|💢/i, 0.8],
  ['thinking', /\b(hmm+|let me (think|see|check)|let'?s see|interesting|consider|depends|it seems|perhaps|maybe|possibly|analy[sz]\w*|figur\w* out)\b|🤔/i, 0.6],
  ['shy', /\b(blush\w*|embarrass\w*|flatter\w*|aww+|you'?re (so )?(sweet|kind|cute|adorable|beautiful|pretty)|thank you so much)\b|🥰|😳|☺️/i, 0.85],
  ['relaxed', /\b(calm|relax\w*|peace\w*|no worries|no problem|take (it|your time)|easy|cozy|chill)\b|😌/i, 0.5]
]

/** compliments / affection aimed at her → bashful */
const AT_HER = /\b(you('| a)?re|ur|u r|nova|cosmos)\b.*\b(cute|adorable|pretty|beautiful|lovely|sweet|smart|best|amazing|awesome|cool)\b|\b(love|like) you\b|\bgood girl\b|\bheadpat\b/i
const GREETING = /^\s*(hi+|hey+|hello+|hiya|yo|good (morning|afternoon|evening)|namaste|greetings)\b/i
const THANKS = /\b(thanks|thank you|thx|ty|appreciate (it|you))\b/i
const FAREWELL = /\b(bye+|goodbye|see you|good ?night|later)\b/i
const AFFIRM = /^\s*(yes|yeah|yep|sure|correct|right|exactly|indeed|absolutely|of course|okay|ok)\b/i

function score(text: string): Reading {
  let best: Reading = { emotion: 'neutral', intensity: 0 }
  for (const [emotion, re, weight] of LEX) {
    const m = text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))
    if (!m) continue
    const s = Math.min(1, weight * (0.75 + 0.25 * m.length))
    if (s > best.intensity) best = { emotion, intensity: s }
  }
  const bangs = (text.match(/!/g) || []).length
  if (best.emotion === 'neutral' && bangs > 0) best = { emotion: 'happy', intensity: Math.min(0.7, 0.35 + 0.15 * bangs) }
  else if (bangs > 1 && (best.emotion === 'happy' || best.emotion === 'joy')) best.intensity = Math.min(1, best.intensity + 0.15)
  return best
}

/** How Nova reacts the moment the user says something to her. */
export function readUserMessage(text: string): Reading {
  if (AT_HER.test(text)) return { emotion: 'shy', intensity: 1, gesture: 'Shy' }
  if (GREETING.test(text)) return { emotion: 'happy', intensity: 0.9, gesture: 'Wave' }
  if (FAREWELL.test(text)) return { emotion: 'happy', intensity: 0.7, gesture: 'Wave' }
  if (THANKS.test(text)) return { emotion: 'joy', intensity: 0.8, gesture: 'Bow' }
  const r = score(text)
  // empathy: a sad user gets a soft, concerned face, not a mirror of anger
  if (r.emotion === 'angry') return { emotion: 'sad', intensity: 0.5 }
  if (r.emotion === 'sad') return { emotion: 'sad', intensity: Math.min(0.8, r.intensity) }
  if (r.emotion === 'excited' || r.emotion === 'joy') return { ...r, gesture: 'Happy' }
  if (r.emotion === 'surprised') return { ...r, gesture: 'Surprised' }
  return r
}

/** Her own reply, sentence by sentence. */
export function readReplySentence(text: string, first: boolean): Reading {
  const r = score(text)
  if (first && AFFIRM.test(text)) r.gesture = 'Nod'
  if (first && GREETING.test(text)) {
    r.gesture = 'Wave'
    if (r.emotion === 'neutral') return { emotion: 'happy', intensity: 0.8, gesture: 'Wave' }
  }
  if (r.emotion === 'excited' && r.intensity > 0.8) r.gesture = 'Happy'
  else if (r.emotion === 'surprised') r.gesture = 'Surprised'
  else if (!r.gesture && text.length > 90 && /\b(because|first|here'?s|the (key|trick|idea)|basically|in short|step)\b/i.test(text)) {
    r.gesture = 'Explain'
  }
  return r
}

/** Split streamed text into finished sentences, keeping the remainder. */
export class SentenceSplitter {
  private buf = ''

  push(delta: string): string[] {
    this.buf += delta
    const out: string[] = []
    const re = /[^.!?\n]*[.!?\n]+["')\]]*\s*/g
    let m: RegExpExecArray | null
    let last = 0
    while ((m = re.exec(this.buf))) {
      if (m[0].trim()) out.push(m[0].trim())
      last = re.lastIndex
    }
    this.buf = this.buf.slice(last)
    return out
  }

  flush(): string {
    const rest = this.buf.trim()
    this.buf = ''
    return rest
  }
}
