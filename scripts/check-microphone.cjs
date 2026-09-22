const { _electron: electron } = require('playwright-core')
const path = require('node:path')

;(async () => {
  const app = await electron.launch({
    executablePath: path.resolve(process.argv[2] || 'release/win-unpacked/COSMOS.exe'),
    timeout: 30000
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const result = await page.evaluate(async () => {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const inputs = devices.filter(d => d.kind === 'audioinput')
      const attempts = []
      for (const audio of [
        { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        true,
        ...inputs.map(d => ({ deviceId: { exact: d.deviceId } }))
      ]) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio })
          try {
            const bytes = await new Promise((resolve, reject) => {
              const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
              let size = 0
              recorder.ondataavailable = e => { size += e.data.size }
              recorder.onerror = reject
              recorder.onstop = () => resolve(size)
              recorder.start()
              setTimeout(() => recorder.stop(), 250)
            })
            attempts.push({ audio, ok: true, bytes, tracks: stream.getAudioTracks().map(t => ({ label: t.label, state: t.readyState })) })
          } finally {
            stream.getTracks().forEach(t => t.stop())
          }
        } catch (e) {
          attempts.push({ audio, ok: false, name: e.name, message: e.message })
        }
      }
      return { url: location.href, inputs: inputs.map(d => ({ id: d.deviceId, label: d.label })), attempts }
    })
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await app.evaluate(({ app }) => app.exit(0))
    await app.close().catch(() => {})
  }
})().catch(e => { console.error(e); process.exitCode = 1 })
