# COSMOS — UI Design System

The visual language: **a holographic command deck at night.** Deep space
blacks, one dominant accent hue (theme-driven), light rendered as glow and
glass — never flat fills.

## 1. Design Tokens

All colors are CSS custom properties set by the active theme on `:root`.
Components NEVER hardcode hues — they reference tokens, so all five themes
work automatically.

| Token             | Role                                            |
|-------------------|-------------------------------------------------|
| `--bg`            | Deepest background (near-black, hue-tinted)     |
| `--bg-elevated`   | Panel base under glass                          |
| `--accent`        | Primary hologram hue (Cyber Blue default)       |
| `--accent-bright` | Hot core of glows, active states                |
| `--accent-dim`    | 30–40% accent for borders, inactive strokes     |
| `--glow`          | rgba accent used in box-shadows / text-shadows  |
| `--text`          | Primary text (slightly hue-tinted white)        |
| `--text-dim`      | Secondary text ~55% opacity                     |
| `--danger`        | Destructive actions (fixed red-orange)          |
| `--success`       | Confirmations (fixed teal-green)                |

### Themes
`cyber-blue` (default) · `crimson` · `nebula-purple` · `emerald` ·
`arctic-white` (light-on-dark inverted glass). Theme = a token map, nothing
else.

## 2. Typography

- **Display / Identity:** `Orbitron` — COSMOS wordmark, boot text, card
  titles. Wide letter-spacing (0.2em+), uppercase.
- **Interface:** `Rajdhani` — data readouts, labels, buttons. Techy but
  readable at small sizes.
- **Body / Chat:** `Inter` — long-form AI responses.
- **Mono:** `JetBrains Mono` — numbers, code, terminal.
- Numbers in stat cards use tabular figures so values don't jitter.

## 3. Surfaces — the Glass recipe

Every panel is the same recipe (the `<Glass>` component):

```css
background: color-mix(in srgb, var(--bg-elevated) 72%, transparent);
backdrop-filter: blur(24px) saturate(140%);
border: 1px solid var(--accent-dim);
border-radius: 16px;
box-shadow: 0 0 24px -8px var(--glow),           /* outer aura   */
            inset 0 1px 0 rgba(255,255,255,.06); /* top bevel    */
```

Plus a 1px accent "scanline" edge on the top border of active panels.
Corners of HUD cards get bracket ticks (`[ ]` corner markers) — the
signature COSMOS frame.

## 4. Motion Language

| Situation           | Pattern                                             |
|---------------------|-----------------------------------------------------|
| Panel enter         | opacity 0→1, y 12→0, blur 8→0, 0.45s `easeOutExpo`  |
| Panel exit          | opacity→0, scale→0.98, 0.2s                         |
| Hover               | border brightens + glow radius grows (no movement)  |
| Data update         | number tween + brief accent flash on the value      |
| Palette open        | scale 0.96→1 + backdrop blur ramp, 0.25s            |
| Boot lines          | GSAP scramble-in (random glyphs → resolve)          |
| Orb states          | shader uniform lerp over 0.6s — never a hard cut    |

Rules: only `transform`, `opacity`, `filter`. Springs for interactive
elements (stiffness ~260, damping ~24), easings for choreography. Nothing
animates longer than 0.6s except ambient loops.

## 5. The AI Core (orb)

- Icosahedron with a custom vertex-noise displacement shader + fresnel rim.
- 2,400-particle orbital field (GPU points, additive blending).
- Two rotating gyroscope rings (thin torus geometry).
- State mapping:
  - **idle** — slow breath (noise amp 0.08, hue calm, particles drift)
  - **listening** — tight fast ripples, ring spin-up, brighter rim
  - **thinking** — turbulent noise, particles contract inward, flicker
  - **speaking** — amplitude pulses on a voice-like LFO, particles ejected

## 6. Layout

```
┌──────────────────────────────────────────────────────┐
│ status bar: wordmark · state · clock                 │
│                                                      │
│  HUD cards          ┌────────┐          chat panel   │
│  (left column,      │  ORB   │          (right,      │
│   draggable)        │ center │           streaming)  │
│                     └────────┘                       │
│ ambient particle background across everything        │
└──────────────────────────────────────────────────────┘
        CTRL+SPACE ⇒ command palette (center modal)
```

## 7. Sound Design

Synthesized in-app via WebAudio (no assets): boot swell (filtered saw
rise), hover tick (2ms sine blip ~2kHz), confirm (major third arpeggio),
error (low detuned pulse), palette open (soft whoosh via noise + filter
sweep). All ≤ -18 dBFS, master mute in settings.

## 8. Accessibility & Restraint

- Text on glass must hit 4.5:1 against `--bg-elevated`.
- `prefers-reduced-motion` collapses boots/loops to fades.
- Glow is garnish: information is always carried by text/value, never only
  by color or bloom.
