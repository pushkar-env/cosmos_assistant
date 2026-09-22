/** Preserve capture failures instead of reporting every failure as a missing mic. */
export function microphoneError(cause: unknown): Error {
  const name = cause instanceof Error ? cause.name : 'UnknownError'
  let message: string
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      message = 'Microphone access is blocked. In Windows Settings > Privacy & security > Microphone, enable Microphone access and Let desktop apps access your microphone, then click the mic again.'
      break
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      message = 'No microphone is available. Connect or enable an input in Windows Settings > System > Sound, then click the mic again.'
      break
    case 'NotReadableError':
    case 'TrackStartError':
      message = 'Windows could not start the microphone. Close apps using it exclusively and check your default input in Windows Sound settings, then retry.'
      break
    case 'OverconstrainedError':
      message = 'The microphone does not support the requested audio settings. Choose a working default input in Windows Sound settings, then retry.'
      break
    default:
      message = `Microphone capture failed (${name}): ${cause instanceof Error ? cause.message : String(cause)}`
  }
  const error = new Error(message, { cause })
  error.name = name
  return error
}
