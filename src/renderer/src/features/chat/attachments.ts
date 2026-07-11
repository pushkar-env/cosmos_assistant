import type { Attachment } from '@shared/types'

/** Per-message limits — keep requests within provider payload/cost bounds. */
export const MAX_FILES = 6
export const MAX_FILE_MB = 16
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024

/** image types every vision provider (Claude/GPT/Gemini) accepts */
const SUPPORTED_IMAGE = /^image\/(png|jpe?g|gif|webp)$/i

/** extensions we treat as readable text documents (extracted & inlined) */
const TEXT_EXT =
  /\.(txt|text|md|markdown|rst|csv|tsv|json|jsonc|ndjson|xml|yaml|yml|toml|ini|cfg|conf|env|log|html?|htm|css|scss|sass|less|js|jsx|mjs|cjs|ts|tsx|py|rb|php|java|kt|kts|c|h|cpp|hpp|cc|cs|go|rs|swift|m|mm|sh|bash|zsh|bat|ps1|sql|graphql|gql|vue|svelte|astro|dockerfile|makefile|gitignore|properties)$/i

let counter = 0
const nextId = (): string => `att-${Date.now()}-${counter++}`

/** data: URL usable in an <img> for an image attachment */
export function imageDataUrl(a: Attachment): string {
  return `data:${a.mime};base64,${a.data ?? ''}`
}

/** human-readable size, e.g. "1.4 MB" */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** longest edge (px) we send — matches the sweet spot for vision models and
 *  keeps requests under provider per-image size caps */
const MAX_IMAGE_DIM = 1568

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(fr.error ?? new Error('read failed'))
    fr.readAsDataURL(file)
  })
}

async function readAsBase64(file: File): Promise<string> {
  return (await readDataUrl(file)).split(',')[1] ?? ''
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image decode failed'))
    img.src = url
  })
}

/**
 * Return base64 bytes for an image, downscaling anything whose long edge
 * exceeds MAX_IMAGE_DIM so large photos/screenshots stay within provider
 * limits. Falls back to the original bytes if canvas encoding is unavailable.
 */
async function prepareImage(file: File): Promise<{ mime: string; data: string }> {
  const dataUrl = await readDataUrl(file)
  const original = { mime: file.type, data: dataUrl.split(',')[1] ?? '' }
  try {
    const img = await loadImage(dataUrl)
    const longEdge = Math.max(img.width, img.height)
    if (longEdge <= MAX_IMAGE_DIM) return original
    const scale = MAX_IMAGE_DIM / longEdge
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.width * scale)
    canvas.height = Math.round(img.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return original
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    // keep PNG (transparency / crisp text); re-encode the rest as JPEG for size
    const outMime = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
    return { mime: outMime, data: canvas.toDataURL(outMime, 0.9).split(',')[1] ?? '' }
  } catch {
    return original
  }
}

/** Heuristic: does a decoded string look like binary rather than text? */
function looksBinary(s: string): boolean {
  const sample = s.slice(0, 2048)
  if (!sample) return false
  let ctrl = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i)
    if (c === 0) return true // NUL → definitely binary
    if (c < 9 || (c > 13 && c < 32)) ctrl++
  }
  return ctrl / sample.length > 0.05
}

function isTextByType(file: File): boolean {
  const mime = file.type
  return (
    mime.startsWith('text/') ||
    /^application\/(json|xml|javascript|x-yaml|x-sh|toml)$/i.test(mime) ||
    TEXT_EXT.test(file.name) ||
    /^(dockerfile|makefile)$/i.test(file.name)
  )
}

/** Convert one File into an Attachment, or null if the type isn't supported. */
async function fileToAttachment(file: File): Promise<Attachment | null> {
  const base = { id: nextId(), name: file.name || 'file', size: file.size }

  if (SUPPORTED_IMAGE.test(file.type)) {
    const { mime, data } = await prepareImage(file)
    return { ...base, kind: 'image', mime, data }
  }

  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
  if (isPdf) {
    return { ...base, kind: 'pdf', mime: 'application/pdf', data: await readAsBase64(file) }
  }

  // an unsupported image (svg/bmp/tiff/…) — reject with a clear signal
  if (file.type.startsWith('image/')) return null

  // text documents: known text type, or an unknown type that decodes as text
  if (isTextByType(file)) {
    return { ...base, kind: 'text', mime: file.type || 'text/plain', text: await file.text() }
  }
  const text = await file.text().catch(() => '')
  if (text && !looksBinary(text)) {
    return { ...base, kind: 'text', mime: file.type || 'text/plain', text }
  }
  return null
}

/**
 * Turn picked/dropped/pasted files into attachments, enforcing the count and
 * size limits. Returns any per-file problems so the UI can surface them.
 */
export async function processFiles(
  files: FileList | File[],
  existingCount: number
): Promise<{ attachments: Attachment[]; errors: string[] }> {
  const attachments: Attachment[] = []
  const errors: string[] = []
  for (const file of Array.from(files)) {
    if (existingCount + attachments.length >= MAX_FILES) {
      errors.push(`You can attach up to ${MAX_FILES} files per message.`)
      break
    }
    if (file.size > MAX_FILE_BYTES) {
      errors.push(`"${file.name}" is too large (max ${MAX_FILE_MB} MB).`)
      continue
    }
    try {
      const att = await fileToAttachment(file)
      if (att) attachments.push(att)
      else errors.push(`"${file.name}" isn't a supported image or document.`)
    } catch {
      errors.push(`Couldn't read "${file.name}".`)
    }
  }
  return { attachments, errors }
}
