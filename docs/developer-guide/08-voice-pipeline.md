# 08 · The Voice Pipeline

Voice is the signature feature and the most intricate subsystem. It spans the
renderer (capture, chunking, playback orchestration) and main (STT + TTS). This
page traces it end to end.

The renderer orchestrator is
[`features/voice/useVoiceStore.ts`](../../src/renderer/src/features/voice/useVoiceStore.ts);
the text utilities are
[`features/voice/speech.ts`](../../src/renderer/src/features/voice/speech.ts);
capture/playback are `core/voice/MicRecorder.ts` and `core/voice/SpeechPlayer.ts`;
STT/TTS are the main-process `voice/SttService.ts` and `voice/TtsService.ts`.

---

## Two directions

```
   INPUT  (speech → text → send)
   ─────────────────────────────
   MicRecorder ──segment(Blob)──▶ useVoiceStore.handleTranscript
       │                              │ window.cosmos.voice.transcribe(bytes, mime)
       │                              ▼
       │                          SttService (main)  → { text }
       │                              │
       │          resolveHandsFree / PTT logic → useAssistantStore.send(text)
       ▼
   (mic amplitude drives the orb while listening)

   OUTPUT  (reply text → speech)
   ─────────────────────────────
   assistant 'delta' events ─▶ SentenceChunker ─▶ speak(sentence)
                                                     │ synthQueue (serial)
                                                     ▼
                              window.cosmos.voice.synthesize(text)
                                                     │
                                          TtsService (main) → audio bytes
                                                     ▼
                                   SpeechPlayer.enqueue(audio, pauseMs)
                              (TTS amplitude drives the orb while speaking)
```

---

## Mic modes

`useVoiceStore` tracks `micMode: 'off' | 'ptt' | 'handsfree'` and `micStatus:
'idle' | 'listening' | 'transcribing'`.

| Mode | Trigger | Behaviour |
|---|---|---|
| **Push-to-talk** | `Ctrl+J` / mic button | One listening session; auto-stops on silence, transcribes, sends. Second press flushes a captured segment or turns the mic off. |
| **Hands-free** | Settings toggle / tray | Always-on mic; a VAD segments speech and **only utterances addressed to "Cosmos"** are executed. Persists across sessions. |
| **Off** | — | Mic idle. |

The composer mic button is context-aware (`toggleMic`): when hands-free is the
user's active mode it **pauses/resumes** hands-free; otherwise it's push-to-talk.

---

## Input: capture → transcript → action

`MicRecorder.start(handsFree, handlers)` captures mic audio and emits speech
**segments** (`onSegment(blob, duringSpeech)`) using voice-activity detection.
`handleTranscript()` then:

1. Transcribes via `window.cosmos.voice.transcribe` → `SttService`.
2. **PTT:** stop the mic, `clearSpeech()`, and `send()` the text (or show "I
   didn't catch that").
3. **Hands-free:** decide meaning with `resolveHandsFree(text, inFollowUp)`:
   - `ignore` — not addressed / an echo → keep listening.
   - `command` — wake word found (or we're in the follow-up window) → `send()` the
     stripped command.
   - `prompt` — a bare "Cosmos" → speak "Yes?"/"जी?" and open a **12s follow-up
     window** in which the next segment is taken as the command without the wake
     word (the VAD usually splits "Cosmos … command" into two segments).

### Wake-word matching (`speech.ts`)

Whisper mishears "Cosmos" constantly, so the matcher targets the **stable
consonant skeleton**, not a fixed spelling:

- **Latin** (`WAKE_RE`): an initial hard-C (`[ckg]`), s/z, m, optional trailing
  s/z, with vowels loose — anchored so "customs", "cosmic", "gizmos" don't
  false-trigger. Optional leading interjections (hey/ok/yo/अरे…) are allowed.
- **Devanagari** (`DEVA_WAKE_RE`): the क–स–म–स skeleton with any combining marks,
  because Whisper writes spoken English "Cosmos" in Devanagari with wildly varying
  vowel signs.

### Echo suppression (`EchoTracker`)

The mic inevitably picks up COSMOS's own TTS (WebAudio echo-cancellation is
imperfect). Rather than blindly dropping every segment that overlaps playback —
which also swallowed genuine user barge-in — it's **content-based**: `note()`
records everything COSMOS is about to say; `isEcho(transcript)` drops a segment
only if its words mostly match recently-spoken text (all words for 1–2-word
transcripts, ≥60% for longer ones, within a 30s window). Real speech over
playback passes through, so wake-word barge-in works.

---

## Output: streaming text → paced speech

### 1. Sentence chunking (`SentenceChunker`)

`useVoiceStore.init()` subscribes to assistant events. Each `delta` is fed to a
`SentenceChunker` that accumulates text and emits **complete sentences**:

- The **first** sentence is released early (min 24 chars, cutting at the first
  clause boundary) so speech starts fast; later ones batch larger (min 60) to
  sound natural.
- It respects structure: never splits inside an unclosed ```code fence```;
  paragraphs (`\n\n`) and completed list items become their own chunks; sentence
  enders include the Devanagari danda (।/॥) for Hindi.
- `flush()` on `done` speaks whatever remains.

### 2. Speakable text (`toSpeakable`)

Before synthesis, markdown and unspeakable syntax are stripped: code fences →
"Code block omitted", links → link text, bare URLs → "link", headings/bullets/
tables/emphasis markers removed, emoji removed, and stray reasoning-model
`<think>` tags scrubbed. Paragraph/line breaks are converted into punctuation so
the synthesizer paces correctly.

### 3. Human pacing (`pauseAfterMs`)

Each chunk carries a pause (silence after it) modeled on human speech:
paragraphs get a full breath (650ms), headings settle (550ms), questions hang
longer than statements, commas barely register (190ms), the Hindi danda is
treated as a full stop — scaled slightly by sentence length with ±15% jitter so
the rhythm isn't metronomic. Pacing is judged on the **raw** text (before
`toSpeakable`) because markdown structure carries the pause cues.

### 4. Serial synthesis + ordered playback

`speak()` pushes `{ text, pauseMs }` onto a **serial** `synthQueue`;
`pumpSynthQueue()` synthesizes one at a time (via `voice.synthesize`) and
enqueues the audio into `SpeechPlayer`, which plays clips in order with the
right gaps. `SpeechPlayer.onStart` sets the assistant state to `speaking`;
`onDrained` returns to `thinking` (if a request is still active) or `idle`.

### 5. Barge-in & the speech epoch

`clearSpeech()` (called on Stop, a new message, or an error) resets the chunker,
empties the queue, stops the player, **and bumps `speechEpoch`**. A synthesis
already in flight captures the epoch and discards its audio if the epoch moved on
— otherwise a late clip would restart the player and strand the Stop button on
"speaking".

---

## STT — `SttService`

`transcribe(audio, mime)` → `{ text }`. Sends the captured audio to a Whisper
backend chosen by `settings.voice.sttProvider`:

| Provider | Notes |
|---|---|
| `openai` | OpenAI Whisper — accurate (uses the OpenAI key) |
| `groq` | Groq Whisper large-v3 — free & fast (free Groq key) |
| `elevenlabs` | ElevenLabs Scribe — multilingual (ElevenLabs key) |

Transcription language is driven by the unified conversation language
(`settings.voice.language`, `en`/`hi`).

---

## TTS — `TtsService`

`synthesize(text)` → `{ data: ArrayBuffer, mime }`, with three backends
(`settings.voice.ttsProvider`):

| Provider | Notes |
|---|---|
| `windows` | SAPI via PowerShell — zero-setup offline fallback, always available |
| `elevenlabs` | Premium online voices (API key), multilingual |
| `piper` | Fully offline neural TTS; bundled English (HFC female/male) + Hindi (Priyamvada/Pratham) voices resolved from `resources/piper` at runtime |

Features:
- **Audio cache** — an LRU, size-capped cache (`tts-cache` in userData; ≤600
  chars, ≤40 MB, ≤400 files) keyed by exact text + voice + model, so repeated
  lines (greeting, "Yes?", acknowledgements) don't re-synthesize or burn
  ElevenLabs credits.
- **Bundled Piper resolution** — `resolvePiper()` maps the selected voice id to
  its `.onnx` in `resources/piper/voices`, so no absolute path is stored and the
  app works on any machine.
- `availableVoiceIds()` and `listElevenLabsVoices()` populate the Settings
  pickers.

The renderer decodes the returned buffer with WebAudio and drives the orb's
speaking amplitude from an `AnalyserNode`.

---

## Bilingual behaviour

One unified conversation language (`settings.voice.language`) drives STT, the
reply language, TTS voice, and even the wake-word acknowledgement. Pick a Hindi
voice and the entire loop is Hindi: speech transcribed in Devanagari, COSMOS
replies in Hindi (persona compiled in Hindi too), spoken by a Hindi voice — while
tool names, app names, and paths stay in their original form. If a typed query
is in a different language than the setting, `useAssistantStore.send` translates
it first (see [AI & the Agent Loop](04-ai-and-agent-loop.md#translation--research-reports)).

---

## Robustness notes for maintainers

- **HMR singletons:** the recorder, player, synth queue, and the assistant-event
  subscription live on `globalThis`, so a hot reload never spins up a second
  player/listener (which would speak every reply twice). See
  [The Renderer](07-renderer.md#hmr-safe-singletons-important-dev-gotcha).
- **Re-arming after minimize:** with `backgroundThrottling: false`, Chromium can
  leave the mic's AudioContext suspended after minimize/hide and it won't recover
  on its own. Main sends `WINDOW_SHOWN` on restore/show; `useVoiceStore` re-arms
  hands-free on that (debounced) plus on `visibilitychange`.
- **Synthesis failures aren't silent:** a TTS error clears the queue and shows a
  throttled toast ("Voice playback failed — check Settings → Voice") so a broken
  Piper path is diagnosable rather than just silent.

---

Next: [Data & Security →](09-data-and-security.md)
