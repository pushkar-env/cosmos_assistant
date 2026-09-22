const { build, Platform } = require('electron-builder')
const { WineVmManager } = require('app-builder-lib/out/vm/WineVm')

// electron-builder 26.15.3 passes only __COMPAT_LAYER when running the NSIS
// uninstaller generator. Windows also needs SystemRoot/TEMP and the rest of
// the inherited environment; otherwise spawning it fails with UNKNOWN.
const execWine = WineVmManager.prototype.execWine
WineVmManager.prototype.execWine = function (args) {
  if (process.platform === 'win32' && args.options?.env) {
    args = { ...args, options: { ...args.options, env: { ...process.env, ...args.options.env } } }
  }
  return execWine.call(this, args)
}

build({ targets: Platform.WINDOWS.createTarget() }).catch(error => {
  console.error(error)
  process.exitCode = 1
})
