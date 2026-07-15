# 10 · Personality System

COSMOS's persona — how it *talks* — is a self-contained, bilingual engine in
[`src/shared/personality.ts`](../../src/shared/personality.ts). It's a single
pure module so the **same code** compiles the system-prompt block in main **and**
drives the picker UI in the renderer — one source of truth, zero drift.

> Design principle, enforced by the compiler: **personality shapes HOW COSMOS
> talks, never WHAT it can do.** Every compiled block ends with a guardrail
> re-asserting full competence, honesty, and tool-willingness.

---

## The three inputs

A persona is `presetId` + `traits` + optional overrides, stored as
`PersonalitySettings` on `Settings.personality`:

```ts
interface PersonalitySettings {
  presetId: string          // which preset (see PERSONA_PRESETS)
  customPrompt: string      // used when presetId === 'custom'
  nickname: string          // overrides the persona's term of endearment
  assistantName: string     // a name COSMOS goes by ('' → COSMOS)
  traits: PersonaTraits     // seven 0–100 sliders
}
```

### 1. Presets (`PERSONA_PRESETS`)

Eleven curated personas plus a Custom slot, each with an identity paragraph
(bilingual), default trait values, an accent color, a term of endearment, a
sample line, and a boot greeting:

`jarvis` (The Assistant, default) · `girlfriend` · `boyfriend` · `bestie` ·
`sarcastic` (The Wit) · `comedian` · `mentor` · `professional` (The Executive) ·
`zen` · `overlord` · `custom`.

### 2. Trait dials (`PERSONA_TRAITS`)

Seven sliders, each 0–100 with labelled poles: **warmth**, **humor**,
**formality**, **sass**, **flirtiness**, **verbosity**, **emoji**. Choosing a
preset seeds these; the user can then fine-tune. `NEUTRAL_TRAITS` is the
all-midpoint baseline.

### 3. Overrides

`assistantName` (a name COSMOS answers to) and `nickname` (what it calls the
user, overriding the persona's natural term).

---

## Localization

Every persona string is a `LocalizedText { en, hi }`. `localize(text, lang)`
picks the copy for the reply language. The whole persona — identity paragraph,
trait sentences, nickname, greeting, sample — ships in **both English and Hindi**,
and the compiler emits the Hindi variant whenever the reply is Hindi. So a Hindi
conversation gets a genuinely Hindi personality, not English text read aloud by a
Hindi voice (which also keeps small local models consistent).

UI chrome (preset `label`, `tagline`) is always English — it's app UI, not spoken
output.

---

## The prompt compiler — `buildPersonaPrompt(settings, lang)`

Called by `AIService.buildSystemPrompt()` with `lang = hindiMode ? 'hi' : 'en'`.
It assembles a `── YOUR PERSONALITY ──` block:

1. **Core identity** — the preset's paragraph in `lang` (or `customPrompt` for the
   Custom preset, falling back to a neutral helpful-assistant line).
2. **Assistant name** — if set, "you go by … (underlying identity is still
   COSMOS)".
3. **Nickname** — `effectiveNickname()` = the user's override, else the persona's
   natural term for the language; a line telling COSMOS to use it naturally and
   sparingly.
4. **Trait dials** — only traits pushed **off-neutral** emit a sentence
   (`≥ HIGH(72)` → the high line, `≤ LOW(28)` → the low line). Mid-range traits
   stay silent so the block stays tight; the preset paragraph already sets the
   baseline vibe.
5. **Guardrail** — the block governs tone/style only; never reduces competence,
   accuracy, honesty, or tool use; drop character the moment the user asks.

Helper functions worth knowing:

| Function | Use |
|---|---|
| `resolvePreset(id)` | Look up a preset, falling back to the default Assistant |
| `normalizePersonality(p)` | Fill in every field/trait safely (defensive against partial stored data) |
| `effectiveNickname(p, lang)` | The term COSMOS calls the user in a language |
| `personaGreeting(p, {name, hour, lang})` | The spoken boot greeting (time-of-day + name + persona flavour) |
| `personaWelcome(p, lang)` | The short on-screen welcome line |

---

## Where it's used

- **Main:** `AIService.buildSystemPrompt` injects the compiled block into every
  turn's system prompt, in the reply language.
- **Renderer:** `features/personality/PersonalityPanel.tsx` renders the picker
  (cards from `PERSONA_PRESETS`, sliders from `PERSONA_TRAITS`, live sample) and
  writes changes to `settings.personality`; `App.tsx` uses `personaGreeting` for
  the boot greeting and welcome toast.

Because both sides import the same module, adding a preset or a trait is a
**one-file change** that shows up in the picker and the prompt simultaneously.

---

## Adding a persona preset

1. Append a `PersonaPreset` to `PERSONA_PRESETS` in `personality.ts` — provide
   both `en` and `hi` for `persona`, `nickname`, `sample`, `greeting`, plus
   `traits`, `emoji`, `tagline`, `color`.
2. That's it — the picker lists it and the compiler can emit it. Keep `custom`
   last.

To add a **trait**, extend `PersonaTraitId`, `PERSONA_TRAITS`, `NEUTRAL_TRAITS`,
each preset's `traits`, and `TRAIT_COPY` (bilingual high/low sentences). The
compiler and picker pick it up automatically.

---

Next: [Extending COSMOS →](11-extending.md)
