/*
 * Requests the app handles itself instead of sending them to the model.
 *
 * Kept deliberately strict: the whole message must BE the command ("start a
 * new chat", "new conversation please", "नई चैट शुरू करो") — a question that
 * merely mentions a new chat ("how do I start a new chat in Slack?") goes to
 * the model as usual.
 */

const POLITE = String.raw`(?:(?:hey|hi|ok(?:ay)?|so|now|please|pls|kindly|cosmos|tsunade|nova|can you|could you|would you|will you|go ahead and|let'?s|i want to|i'?d like to|i wanna)[\s,]+)*`
const TAIL = String.raw`(?:[\s,]+(?:please|pls|now|for me|right now|again|cosmos|tsunade|nova|thanks|thank you))*`
const VERB = String.raw`(?:start|open|begin|create|make|launch|spin up|give me|get me)`
const FRESH = String.raw`(?:a\s+)?(?:new|fresh|clean|brand[\s-]?new)(?:\s+one)?`
const THING = String.raw`(?:chat|conversation|convo|session|thread|chat window)`

const EN: RegExp[] = [
  // "start a new chat", "can you open a fresh conversation please"
  new RegExp(`^${POLITE}${VERB}\\s+${FRESH}\\s+${THING}${TAIL}$`),
  // "new chat", "fresh conversation please"
  new RegExp(`^${POLITE}(?:a\\s+)?(?:new|fresh)\\s+${THING}${TAIL}$`),
  // "clear the chat", "reset this conversation"
  new RegExp(`^${POLITE}(?:clear|reset|wipe|restart)\\s+(?:the|this|my|our)?\\s*${THING}${TAIL}$`),
  // "start over", "start fresh"
  new RegExp(`^${POLITE}start\\s+(?:over|fresh|afresh|again from scratch)${TAIL}$`)
]

// Hindi / Hinglish: नई चैट शुरू करो · नया चैट खोलो · nayi chat shuru karo
const HI: RegExp[] = [
  /^(?:कृपया\s+)?(?:एक\s+)?(?:नई|नया|नयी)\s+(?:चैट|बातचीत|कन्वर्सेशन)\s+(?:शुरू|चालू|खोल|बना)\S*\s*(?:करो|करें|कीजिए|कर दो|दो|दीजिए)?(?:\s+(?:प्लीज़|कृपया))?$/,
  /^(?:चैट|बातचीत)\s+(?:साफ़|साफ|क्लियर|रीसेट)\s*(?:करो|करें|कीजिए|कर दो)?$/,
  /^(?:please\s+)?(?:ek\s+)?(?:nayi|nai|naya|new)\s+(?:chat|baatcheet|conversation)\s+(?:shuru|start|chalu|khol|open)\w*\s*(?:karo|karen|kijiye|kar do|do)?(?:\s+please)?$/
]

/** true when the whole message asks for a fresh chat */
export function isNewChatIntent(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.!?।…"'“”]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t || t.length > 80) return false
  return EN.some((re) => re.test(t)) || HI.some((re) => re.test(t))
}
