import type { Config } from 'tailwindcss'

export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        elevated: 'var(--bg-elevated)',
        accent: 'var(--accent)',
        'accent-bright': 'var(--accent-bright)',
        'accent-dim': 'var(--accent-dim)',
        body: 'var(--text)',
        dim: 'var(--text-dim)',
        danger: 'var(--danger)',
        success: 'var(--success)'
      },
      fontFamily: {
        display: ['Orbitron', 'sans-serif'],
        ui: ['Rajdhani', 'sans-serif'],
        body: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'Consolas', 'monospace']
      },
      boxShadow: {
        glow: '0 0 24px -8px var(--glow)',
        'glow-lg': '0 0 48px -8px var(--glow)'
      }
    }
  },
  plugins: []
} satisfies Config
