const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const source = fs.readFileSync('src/renderer/src/core/voice/microphoneError.ts', 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const exportsObject = {}
vm.runInNewContext(compiled, { exports: exportsObject, Error })
for (const [name, expected] of [
  ['NotAllowedError', /access is blocked.*Let desktop apps/],
  ['PermissionDeniedError', /access is blocked/],
  ['NotFoundError', /No microphone is available/],
  ['NotReadableError', /using it exclusively/],
  ['OverconstrainedError', /does not support/],
  ['AbortError', /AbortError.*capture interrupted/]
]) {
  const cause = new Error('capture interrupted')
  cause.name = name
  const result = exportsObject.microphoneError(cause)
  assert.match(result.message, expected)
  assert.equal(result.name, name)
  assert.equal(result.cause, cause)
}
console.log('PASS: microphone errors retain their cause and show the correct recovery steps')
