import { Component, useCallback, useState, type ReactNode } from 'react'
import { useSettingsStore } from '@/core/stores/useSettingsStore'
import { OrbScene } from '@/features/orb/OrbScene'
import { AvatarScene } from './AvatarScene'

/** Any crash inside the avatar canvas falls back to the orb instead of a blank core. */
class AvatarBoundary extends Component<{ onFail: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(err: unknown): void {
    console.error('[avatar] render failed — falling back to the orb:', err)
    this.props.onFail()
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

/** The centrepiece of the main view: Nova, or the classic AI core orb. */
export function CoreStage(): React.JSX.Element {
  const visual = useSettingsStore((s) => s.settings.coreVisual)
  const [failed, setFailed] = useState(false)
  const onFail = useCallback(() => setFailed(true), [])

  if (visual === 'avatar' && !failed) {
    return (
      <AvatarBoundary onFail={onFail}>
        <AvatarScene onFail={onFail} />
      </AvatarBoundary>
    )
  }
  return <OrbScene />
}
