import { app, desktopCapturer, screen } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

/** Capture the primary display as a PNG buffer. */
export async function captureScreenPng(): Promise<Buffer> {
  const { width, height } = screen.getPrimaryDisplay().size
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  })
  const primary = sources[0]
  if (!primary) throw new Error('No screen source available')
  return primary.thumbnail.toPNG()
}

/** Capture the primary display to a timestamped PNG under Pictures. */
export async function captureScreenToFile(prefix = 'screenshot'): Promise<string> {
  const png = await captureScreenPng()
  const dir = join(app.getPath('pictures'), 'COSMOS Screenshots')
  await fs.mkdir(dir, { recursive: true })
  const file = join(dir, `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
  await fs.writeFile(file, png)
  return file
}
