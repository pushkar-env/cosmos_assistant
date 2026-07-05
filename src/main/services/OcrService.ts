import { app } from 'electron'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * Fully offline OCR via the Windows built-in OCR engine (WinRT
 * Windows.Media.Ocr), driven through a PowerShell shim. Zero
 * dependencies, no network — verified working on this platform.
 */
const OCR_SCRIPT = `param([string]$Path)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
function Await($WinRtTask, $ResultType) {
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
    })[0]
  $t = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
  $null = $t.Wait(15000)
  $t.Result
}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { Write-Output 'NO_ENGINE'; exit 1 }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
Write-Output $result.Text
`

export class OcrService {
  private scriptPath: string | null = null

  private ensureScript(): string {
    if (this.scriptPath && existsSync(this.scriptPath)) return this.scriptPath
    const dir = join(app.getPath('userData'), 'shims')
    mkdirSync(dir, { recursive: true })
    this.scriptPath = join(dir, 'cosmos-ocr.ps1')
    writeFileSync(this.scriptPath, OCR_SCRIPT, 'utf-8')
    return this.scriptPath
  }

  recognize(imagePath: string): Promise<string> {
    const script = this.ensureScript()
    return new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', imagePath],
        { windowsHide: true, timeout: 45_000, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout) => {
          const text = stdout.trim()
          if (err) return reject(new Error(`OCR failed: ${err.message}`))
          if (text === 'NO_ENGINE') return reject(new Error('Windows OCR engine unavailable'))
          resolve(text || '(no text recognized)')
        }
      )
    })
  }
}
