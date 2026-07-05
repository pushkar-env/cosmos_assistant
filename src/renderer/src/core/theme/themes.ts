import type { ThemeId } from '@shared/types'

export interface ThemeTokens {
  bg: string
  bgElevated: string
  accent: string
  accentBright: string
  accentDim: string
  glow: string
  text: string
  textDim: string
}

export const THEMES: Record<ThemeId, { label: string; tokens: ThemeTokens }> = {
  'cyber-blue': {
    label: 'Cyber Blue',
    tokens: {
      bg: '#02050a',
      bgElevated: '#071120',
      accent: '#22d3ee',
      accentBright: '#7df9ff',
      accentDim: 'rgba(34, 211, 238, 0.28)',
      glow: 'rgba(34, 211, 238, 0.45)',
      text: '#e6f6ff',
      textDim: 'rgba(230, 246, 255, 0.55)'
    }
  },
  crimson: {
    label: 'Crimson Protocol',
    tokens: {
      bg: '#0a0204',
      bgElevated: '#1c0710',
      accent: '#f43f5e',
      accentBright: '#ff8fa3',
      accentDim: 'rgba(244, 63, 94, 0.28)',
      glow: 'rgba(244, 63, 94, 0.45)',
      text: '#ffeef1',
      textDim: 'rgba(255, 238, 241, 0.55)'
    }
  },
  'nebula-purple': {
    label: 'Nebula Purple',
    tokens: {
      bg: '#050208',
      bgElevated: '#120726',
      accent: '#a78bfa',
      accentBright: '#d5c5ff',
      accentDim: 'rgba(167, 139, 250, 0.28)',
      glow: 'rgba(167, 139, 250, 0.45)',
      text: '#f2ecff',
      textDim: 'rgba(242, 236, 255, 0.55)'
    }
  },
  emerald: {
    label: 'Emerald Matrix',
    tokens: {
      bg: '#020805',
      bgElevated: '#071c12',
      accent: '#34d399',
      accentBright: '#8affd1',
      accentDim: 'rgba(52, 211, 153, 0.28)',
      glow: 'rgba(52, 211, 153, 0.45)',
      text: '#eafff5',
      textDim: 'rgba(234, 255, 245, 0.55)'
    }
  },
  'arctic-white': {
    label: 'Arctic White',
    tokens: {
      bg: '#05070c',
      bgElevated: '#10151f',
      accent: '#e2e8f0',
      accentBright: '#ffffff',
      accentDim: 'rgba(226, 232, 240, 0.25)',
      glow: 'rgba(226, 232, 240, 0.35)',
      text: '#f4f7fb',
      textDim: 'rgba(244, 247, 251, 0.55)'
    }
  }
}

/** Writes a theme's tokens onto :root. */
export function applyTheme(id: ThemeId): void {
  const t = THEMES[id].tokens
  const root = document.documentElement.style
  root.setProperty('--bg', t.bg)
  root.setProperty('--bg-elevated', t.bgElevated)
  root.setProperty('--accent', t.accent)
  root.setProperty('--accent-bright', t.accentBright)
  root.setProperty('--accent-dim', t.accentDim)
  root.setProperty('--glow', t.glow)
  root.setProperty('--text', t.text)
  root.setProperty('--text-dim', t.textDim)
}
