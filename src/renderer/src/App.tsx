import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useUIStore } from '@/core/stores/useUIStore'
import { useSystemStore } from '@/core/stores/useSystemStore'
import { useSettingsStore } from '@/core/stores/useSettingsStore'
import { useAssistantStore } from '@/core/stores/useAssistantStore'
import { useVoiceStore } from '@/features/voice/useVoiceStore'
import { useApprovalStore } from '@/features/chat/useApprovalStore'
import { useAgentStore } from '@/features/agents/useAgentStore'
import { AgentRing } from '@/features/agents/AgentRing'
import { sound } from '@/core/sound/SoundEngine'
import { BootSequence } from '@/features/boot/BootSequence'
import { OrbScene } from '@/features/orb/OrbScene'
import { HudLayer } from '@/features/hud/HudLayer'
import { StatusBar } from '@/features/hud/StatusBar'
import { ChatPanel } from '@/features/chat/ChatPanel'
import { CommandPalette } from '@/features/palette/CommandPalette'
import { SettingsPanel } from '@/features/settings/SettingsPanel'
import { VaultPanel } from '@/features/vault/VaultPanel'
import { SecretsPanel } from '@/features/secrets/SecretsPanel'
import { DashboardPanel } from '@/features/dashboard/DashboardPanel'
import { WorkspacePanel } from '@/features/workspace/WorkspacePanel'
import { StudioPanel } from '@/features/studio/StudioPanel'
import { AppCenterPanel } from '@/features/appcenter/AppCenterPanel'
import { PersonalityPanel } from '@/features/personality/PersonalityPanel'
import { Toasts } from '@/features/notifications/Toasts'
import { NotificationCenter } from '@/features/notifications/NotificationCenter'
import { MiniView } from '@/features/compact/MiniView'
import { OrbWidget } from '@/features/compact/OrbWidget'
import { useNotificationStore } from '@/core/stores/useNotificationStore'
import { personaGreeting } from '@shared/personality'

export default function App(): React.JSX.Element {
  const phase = useUIStore((s) => s.phase)
  const mode = useUIStore((s) => s.mode)
  const togglePalette = useUIStore((s) => s.togglePalette)

  useEffect(() => {
    void useSettingsStore
      .getState()
      .init()
      .then(() => {
        sound.enabled = useSettingsStore.getState().settings.soundEnabled
        useVoiceStore.getState().init() // after settings: may resume hands-free
      })
    useSystemStore.getState().init()
    useAssistantStore.getState().init()
    useApprovalStore.getState().init()
    useAgentStore.getState().init()
    useNotificationStore.getState().init()
    useUIStore.getState().init()

    const offPalette = window.cosmos.app.onPaletteToggle(() => togglePalette())
    // tray "Hands-free" menu item toggles it here, then we sync the tray back
    const offHandsFree = window.cosmos.app.onHandsFreeToggle(() => {
      const on = useVoiceStore.getState().micMode === 'handsfree'
      void useVoiceStore.getState().setHandsFree(!on)
      window.cosmos.app.notifyHandsFreeChanged()
    })
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.code === 'Space') {
        e.preventDefault()
        togglePalette()
      }
      if (e.ctrlKey && e.code === 'KeyJ') {
        e.preventDefault()
        void useVoiceStore.getState().togglePushToTalk()
      }
      if (e.key === 'Escape') {
        useUIStore.getState().setPanel('none')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offPalette()
      offHandsFree()
      window.removeEventListener('keydown', onKey)
    }
  }, [togglePalette])

  // Welcome greeting once the boot cinematic finishes — toast + spoken.
  useEffect(() => {
    if (phase !== 'main') return
    const s = useSettingsStore.getState().settings
    const hi = s.voice.language === 'hi'
    // persona- and language-flavoured greeting (time of day + name + persona line)
    const greeting = personaGreeting(s.personality, {
      name: s.userName,
      hour: new Date().getHours(),
      lang: hi ? 'hi' : 'en'
    })
    const t = setTimeout(() => {
      // greeting is spoken during the boot wordmark reveal (BootSequence);
      // here we surface the matching on-screen welcome toast
      useNotificationStore.getState().push({
        title: hi ? 'कॉसमॉस में आपका स्वागत है' : 'Welcome to COSMOS',
        body: `${greeting} ${hi ? 'कमांड के लिए Ctrl+Space दबाएँ।' : 'Press Ctrl+Space for commands.'}`,
        kind: 'success'
      })
    }, 900)
    return () => clearTimeout(t)
  }, [phase])

  // orb mode: transparent window so only the round orb shows
  const rootBg = mode === 'orb' ? 'transparent' : 'var(--bg)'

  return (
    <div className="relative h-full w-full overflow-hidden" style={{ background: rootBg }}>
      <AnimatePresence>{phase === 'boot' && <BootSequence key="boot" />}</AnimatePresence>

      {phase === 'main' && mode === 'orb' && <OrbWidget />}

      {phase === 'main' && mode === 'compact' && <MiniView />}

      {phase === 'main' && mode === 'full' && (
        <motion.main
          className="relative h-full w-full"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.9 }}
        >
          {/* ambient vignette + rotating aura behind the orb */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'radial-gradient(ellipse 60% 50% at 50% 45%, color-mix(in srgb, var(--accent) 6%, transparent), transparent 70%)'
            }}
          />
          <div className="orb-aura pointer-events-none absolute left-1/2 top-1/2 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full" />

          {/* the AI core */}
          <div className="absolute inset-0">
            <OrbScene />
          </div>

          <StatusBar />
          <AgentRing />
          <HudLayer />
          <ChatPanel />
          <CommandPalette />
          <SettingsPanel />
          <VaultPanel />
          <SecretsPanel />
          <DashboardPanel />
          <WorkspacePanel />
          <StudioPanel />
          <AppCenterPanel />
          <PersonalityPanel />
          <NotificationCenter />
          <Toasts />
        </motion.main>
      )}
    </div>
  )
}
