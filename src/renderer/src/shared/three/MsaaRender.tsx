import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

/**
 * WebGL context for our canvases: no antialiasing and no depth buffer of its
 * own — `MsaaRender` gives the scene both.
 */
export const CANVAS_GL = {
  antialias: false,
  depth: false,
  stencil: false,
  alpha: true,
  powerPreference: 'high-performance'
} as const

/**
 * Draws the scene with 4× MSAA into a framebuffer of our own and resolves it
 * into the canvas, instead of asking the browser for an antialiased canvas.
 *
 * The pixels are the same — the browser resolves its own MSAA buffer with the
 * very same blit (checked bit for bit) — but the memory is not: on Windows
 * (ANGLE on D3D11) an `antialias: true` canvas of 1920×1020 kept ~250 MB more
 * in the GPU process than this does, swinging ±150 MB as it went. On an
 * integrated GPU that is plain RAM.
 *
 * It takes over R3F's render (useFrame priority 1), so a canvas has one of
 * these and no other render callback. `parked`: no frames are coming (hidden
 * to the tray) — the samples are let go until the next frame needs them.
 */
export function MsaaRender({ samples = 4, parked = false }: { samples?: number; parked?: boolean }): null {
  const gl = useThree((s) => s.gl)
  const target = useMemo(() => new MsaaTarget(gl, samples), [gl, samples])
  useEffect(() => {
    // a lost context takes the buffers with it: build them again once back
    const canvas = gl.domElement
    canvas.addEventListener('webglcontextrestored', target.forget)
    return () => {
      canvas.removeEventListener('webglcontextrestored', target.forget)
      target.release()
    }
  }, [gl, target])
  useEffect(() => {
    if (parked) target.release()
  }, [parked, target])
  useFrame(({ scene, camera }) => target.render(scene, camera), 1)
  return null
}

/** three's hook for drawing into a framebuffer it doesn't own (its WebXR
 *  manager uses it) — not in @types/three */
interface ExternalFramebuffers {
  setRenderTargetFramebuffer(target: THREE.WebGLRenderTarget, framebuffer: WebGLFramebuffer | null): void
}

class MsaaTarget {
  private fbo: WebGLFramebuffer | null = null
  private color: WebGLRenderbuffer | null = null
  private depth: WebGLRenderbuffer | null = null
  private rt: THREE.WebGLRenderTarget | null = null
  private width = 0
  private height = 0

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly samples: number
  ) {}

  /** drop the buffers without deleting them (a lost context took them) */
  readonly forget = (): void => {
    this.fbo = this.color = this.depth = null
    this.rt = null
    this.width = this.height = 0
  }

  /** the framebuffer, (re)sized to the canvas's drawing buffer */
  private ensure(gl: WebGL2RenderingContext): THREE.WebGLRenderTarget {
    const w = gl.drawingBufferWidth
    const h = gl.drawingBufferHeight
    if (this.rt && w === this.width && h === this.height) return this.rt
    const state = this.renderer.state
    if (!this.fbo) {
      this.fbo = gl.createFramebuffer()
      this.color = gl.createRenderbuffer()
      this.depth = gl.createRenderbuffer()
    }
    const n = Math.min(this.samples, gl.getParameter(gl.MAX_SAMPLES) as number)
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.color)
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, n, gl.RGBA8, w, h)
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth)
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, n, gl.DEPTH_COMPONENT24, w, h)
    gl.bindRenderbuffer(gl.RENDERBUFFER, null)
    state.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.color)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth)
    state.bindFramebuffer(gl.FRAMEBUFFER, null)
    // three draws into an XR target exactly as into the canvas (output colour
    // space, tone mapping, clear colour) — and into a framebuffer it doesn't
    // own, so it never allocates a texture for it. (Never dispose() it: that
    // would delete our framebuffer; a new size gets a new target instead.)
    const rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true, stencilBuffer: false })
    ;(rt as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true
    rt.texture.colorSpace = this.renderer.outputColorSpace
    ;(this.renderer as unknown as ExternalFramebuffers).setRenderTargetFramebuffer(rt, this.fbo)
    this.rt = rt
    this.width = w
    this.height = h
    return rt
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    const renderer = this.renderer
    const gl = renderer.getContext() as WebGL2RenderingContext
    if (gl.isContextLost()) return
    renderer.setRenderTarget(this.ensure(gl))
    renderer.render(scene, camera)
    renderer.setRenderTarget(null)
    // resolve the samples into the canvas
    const state = renderer.state
    state.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo)
    state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST)
    state.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
  }

  /** free the buffers; the next render makes them again */
  release(): void {
    const gl = this.renderer.getContext()
    if (this.fbo) gl.deleteFramebuffer(this.fbo)
    if (this.color) gl.deleteRenderbuffer(this.color)
    if (this.depth) gl.deleteRenderbuffer(this.depth)
    this.forget()
  }
}
