import { useEffect, useRef } from 'react'

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  alpha: number
  /** pre-rasterised glow sprite for this particle's radius */
  sprite: HTMLCanvasElement
}

/**
 * Resolve a theme token (`--accent` may be a hex, an `rgb()` or a colour name)
 * to plain RGB parts, by letting the canvas normalise it for us.
 */
function toRgb(css: string): [number, number, number] {
  const probe = document.createElement('canvas').getContext('2d')
  let value = css
  if (probe) {
    probe.fillStyle = '#ffffff' // fallback if `css` is not a valid colour
    probe.fillStyle = css
    value = probe.fillStyle as string
  }
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value)
  if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)]
  const nums = value.match(/[\d.]+/g)
  if (nums && nums.length >= 3) return [Number(nums[0]), Number(nums[1]), Number(nums[2])]
  return [255, 255, 255]
}

/**
 * Lightweight 2D canvas particle drift for the boot screen — the WebGL
 * scene isn't mounted yet, so this keeps startup instant.
 */
export function BootParticles(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    const dpr = Math.min(window.devicePixelRatio, 2)

    const resize = (): void => {
      canvas.width = window.innerWidth * dpr
      canvas.height = window.innerHeight * dpr
    }
    resize()
    window.addEventListener('resize', resize)

    const accent = getComputedStyle(document.documentElement)
      .getPropertyValue('--accent')
      .trim()
    const [r, g, b] = toRgb(accent)
    const glow = 8 * dpr

    /**
     * Each particle is a solid dot inside a soft halo. That used to be an
     * `arc()` fill with `ctx.shadowBlur`, but canvas shadows are re-blurred on
     * the CPU for *every* fill — 110 of them per frame is what made the boot
     * screen stutter and spike the CPU. Rasterising the same look once per
     * radius and blitting it is visually identical and costs a memcpy.
     */
    const sprites = new Map<number, HTMLCanvasElement>()
    const spriteFor = (radius: number): HTMLCanvasElement => {
      const key = Math.round(radius * 4) / 4 // quantise: ~6 sprites, sub-pixel apart
      const cached = sprites.get(key)
      if (cached) return cached

      const half = Math.ceil(key + glow)
      const size = half * 2
      const sprite = document.createElement('canvas')
      sprite.width = size
      sprite.height = size
      const sctx = sprite.getContext('2d')
      if (sctx) {
        const grad = sctx.createRadialGradient(half, half, 0, half, half, half)
        const core = Math.min(0.95, key / half) // where the solid dot ends
        const at = (t: number): number => Math.min(1, core + (1 - core) * t)
        grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`)
        grad.addColorStop(core, `rgba(${r}, ${g}, ${b}, 1)`)
        grad.addColorStop(at(0.18), `rgba(${r}, ${g}, ${b}, 0.42)`)
        grad.addColorStop(at(0.45), `rgba(${r}, ${g}, ${b}, 0.12)`)
        grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`)
        sctx.fillStyle = grad
        sctx.fillRect(0, 0, size, size)
      }
      sprites.set(key, sprite)
      return sprite
    }

    const count = 110
    const particles: Particle[] = Array.from({ length: count }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 0.35 * dpr,
      vy: (Math.random() - 0.5) * 0.35 * dpr - 0.15 * dpr,
      alpha: Math.random() * 0.6 + 0.15,
      sprite: spriteFor((Math.random() * 1.6 + 0.4) * dpr)
    }))

    const frame = (): void => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      for (const p of particles) {
        p.x += p.vx
        p.y += p.vy
        if (p.x < 0) p.x = canvas.width
        if (p.x > canvas.width) p.x = 0
        if (p.y < 0) p.y = canvas.height
        if (p.y > canvas.height) p.y = 0
        ctx.globalAlpha = p.alpha
        const half = p.sprite.width / 2
        ctx.drawImage(p.sprite, p.x - half, p.y - half)
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
}
