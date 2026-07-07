// Provisions the bundled Piper runtime + voice models into
// resources/piper/ so `npm run dist` can package them. These assets are
// large (~270 MB) and third-party, so they're gitignored and fetched from
// their upstream homes instead of living in the repo. Idempotent: files
// already present (and non-truncated) are left alone.
//
// Run manually with `npm run setup:piper`; it also runs automatically
// before `npm run dist` via the `predist` hook.
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'resources', 'piper')
const voicesDir = join(dest, 'voices')

// Pinned Piper Windows build (piper.exe + DLLs + espeak-ng-data).
const PIPER_ZIP =
  'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip'

// Bundled voices — KEEP IN SYNC with BUNDLED_VOICES in src/shared/types.ts.
// Path format on HuggingFace rhasspy/piper-voices: <lang>/<locale>/<name>/<quality>/<id>
const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main'
const VOICES = [
  'en/en_US/hfc_female/medium/en_US-hfc_female-medium',
  'en/en_US/hfc_male/medium/en_US-hfc_male-medium',
  'hi/hi_IN/pratham/medium/hi_IN-pratham-medium',
  'hi/hi_IN/priyamvada/medium/hi_IN-priyamvada-medium'
]

/** a real medium model is ~60 MB; smaller means a truncated / error download */
const MIN_VOICE_BYTES = 40_000_000

async function download(url, out) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(out))
}

async function ensureRuntime() {
  if (existsSync(join(dest, 'piper.exe'))) {
    console.log('✓ piper runtime already present')
    return
  }
  mkdirSync(dest, { recursive: true })
  const zip = join(dest, '_piper.zip')
  const tmp = join(dest, '_extract')
  console.log('↓ downloading piper runtime …')
  await download(PIPER_ZIP, zip)
  rmSync(tmp, { recursive: true, force: true })
  // Windows-only build → PowerShell Expand-Archive avoids a zip dependency
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -Force -Path '${zip}' -DestinationPath '${tmp}'`
  ])
  // the archive nests everything under a top-level piper/ folder — flatten it
  const inner = join(tmp, 'piper')
  for (const name of readdirSync(inner)) {
    if (name === 'libtashkeel_model.ort') continue // ~10 MB Arabic model, unused
    renameSync(join(inner, name), join(dest, name))
  }
  rmSync(tmp, { recursive: true, force: true })
  rmSync(zip, { force: true })
  console.log('✓ piper runtime installed')
}

async function ensureVoices() {
  mkdirSync(voicesDir, { recursive: true })
  for (const path of VOICES) {
    const id = path.split('/').pop()
    const onnx = join(voicesDir, `${id}.onnx`)
    if (existsSync(onnx) && statSync(onnx).size > MIN_VOICE_BYTES) {
      console.log(`✓ ${id}`)
      continue
    }
    console.log(`↓ downloading ${id} …`)
    await download(`${HF}/${path}.onnx`, onnx)
    await download(`${HF}/${path}.onnx.json`, `${onnx}.json`)
    if (statSync(onnx).size <= MIN_VOICE_BYTES) {
      throw new Error(`${id} downloaded too small — the URL may be wrong`)
    }
    console.log(`✓ ${id}`)
  }
}

try {
  await ensureRuntime()
  await ensureVoices()
  console.log('\nPiper assets ready in resources/piper — safe to run `npm run dist`.')
} catch (err) {
  console.error('\n✗ Piper provisioning failed:', err.message)
  process.exit(1)
}
