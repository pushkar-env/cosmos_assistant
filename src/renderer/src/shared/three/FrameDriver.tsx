import { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'

/**
 * Drives the scene at a fixed rate instead of once per vsync (see ORB_FPS), and
 * parks it entirely when `fps` is null. The canvas runs `frameloop="never"` and
 * every frame comes from here.
 */
export function FrameDriver({ fps }: { fps: number | null }): null {
  const advance = useThree((s) => s.advance)
  /** seconds of *driven* time — survives a pause, so returning from the tray
   *  resumes the animation where it left off instead of teleporting it */
  const clock = useRef(0)

  useEffect(() => {
    if (fps == null) return
    let raf = 0
    let prev = performance.now()
    let acc = 0
    const step = 1000 / fps

    const loop = (now: number): void => {
      raf = requestAnimationFrame(loop)
      const dt = now - prev
      prev = now
      clock.current += dt / 1000
      acc += dt
      if (acc < step) return
      // carry at most one frame of debt, so a stall can't burst-render
      acc = Math.min(acc - step, step)
      // r3f advances its clock in SECONDS under frameloop="never"
      advance(clock.current)
    }

    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [advance, fps])

  return null
}
