import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { DriveUsage, InstalledProgram, JunkCategory, LargeFile } from '@shared/types'
import { useUIStore } from '@/core/stores/useUIStore'
import { useSettingsStore } from '@/core/stores/useSettingsStore'
import { useAssistantStore } from '@/core/stores/useAssistantStore'
import { Glass } from '@/shared/ui/Glass'
import { useCleanerStore, fmtBytes } from './useCleanerStore'

type Lang = 'en' | 'hi'
type Tab = 'clean' | 'large' | 'apps'

/** The shape of the panel's UI copy, so both languages stay in lock-step. */
interface CleanerStrings {
  title: string
  subtitle: string
  tabs: Record<Tab, string>
  ask: string
  scan: string
  rescan: string
  scanning: string
  reclaimable: string
  selectAll: string
  clear: string
  clean: string
  cleaning: string
  selected: string
  freedBanner: (s: string) => string
  allClean: string
  scanPrompt: string
  items: (n: number) => string
  minSize: string
  findFiles: string
  largePrompt: string
  noLarge: string
  idle: (d: number) => string
  reveal: string
  deleteSel: string
  recoverable: string
  searchApps: string
  refresh: string
  loadingApps: string
  uninstall: string
  uninstalling: string
  confirm: string
  noApps: string
  unknownSize: string
  free: string
  used: string
}

/** Bilingual UI strings — the panel chrome switches with the conversation language. */
const STR: Record<Lang, CleanerStrings> = {
  en: {
    title: 'System Cleaner',
    subtitle: 'Scan · optimize · free space',
    tabs: { clean: 'Clean', large: 'Large Files', apps: 'Apps' },
    ask: 'Ask COSMOS',
    scan: 'Scan',
    rescan: 'Re-scan',
    scanning: 'Scanning…',
    reclaimable: 'reclaimable',
    selectAll: 'Select all',
    clear: 'Clear',
    clean: 'Clean',
    cleaning: 'Cleaning…',
    selected: 'selected',
    freedBanner: (s: string) => `Reclaimed ${s} — nicely done.`,
    allClean: 'Everything is spotless — no junk to remove.',
    scanPrompt: 'Run a scan to find reclaimable junk.',
    items: (n: number) => `${n} item${n === 1 ? '' : 's'}`,
    minSize: 'Min size (MB)',
    findFiles: 'Find files',
    largePrompt: 'Find the biggest files in your personal folders.',
    noLarge: 'No files that large in your Downloads, Desktop, Documents, Videos, Music or Pictures.',
    idle: (d: number) => `idle ${d}d`,
    reveal: 'Show',
    deleteSel: 'Move to Recycle Bin',
    recoverable: 'Deleted files go to the Recycle Bin (recoverable).',
    searchApps: 'Search programs…',
    refresh: 'Refresh',
    loadingApps: 'Reading installed programs…',
    uninstall: 'Uninstall',
    uninstalling: 'Starting…',
    confirm: 'Confirm?',
    noApps: 'No installed programs found.',
    unknownSize: 'size n/a',
    free: 'free',
    used: 'used'
  },
  hi: {
    title: 'सिस्टम क्लीनर',
    subtitle: 'स्कैन · ऑप्टिमाइज़ · जगह खाली करें',
    tabs: { clean: 'साफ़ करें', large: 'बड़ी फ़ाइलें', apps: 'ऐप्स' },
    ask: 'COSMOS से पूछें',
    scan: 'स्कैन',
    rescan: 'फिर स्कैन',
    scanning: 'स्कैन हो रहा है…',
    reclaimable: 'खाली की जा सकती है',
    selectAll: 'सभी चुनें',
    clear: 'हटाएँ',
    clean: 'साफ़ करें',
    cleaning: 'साफ़ हो रहा है…',
    selected: 'चयनित',
    freedBanner: (s: string) => `${s} जगह खाली हुई — बढ़िया!`,
    allClean: 'सब कुछ साफ़ है — हटाने के लिए कुछ नहीं।',
    scanPrompt: 'खाली की जा सकने वाली जंक फ़ाइलें खोजने के लिए स्कैन करें।',
    items: (n: number) => `${n} आइटम`,
    minSize: 'न्यूनतम आकार (MB)',
    findFiles: 'फ़ाइलें खोजें',
    largePrompt: 'अपने फ़ोल्डरों की सबसे बड़ी फ़ाइलें खोजें।',
    noLarge: 'आपके फ़ोल्डरों में इतनी बड़ी फ़ाइलें नहीं मिलीं।',
    idle: (d: number) => `${d} दिन से बंद`,
    reveal: 'दिखाएँ',
    deleteSel: 'रीसायकल बिन में भेजें',
    recoverable: 'हटाई गई फ़ाइलें रीसायकल बिन में जाती हैं (वापस पाई जा सकती हैं)।',
    searchApps: 'प्रोग्राम खोजें…',
    refresh: 'रिफ़्रेश',
    loadingApps: 'इंस्टॉल प्रोग्राम पढ़े जा रहे हैं…',
    uninstall: 'अनइंस्टॉल',
    uninstalling: 'शुरू हो रहा है…',
    confirm: 'पक्का?',
    noApps: 'कोई इंस्टॉल प्रोग्राम नहीं मिला।',
    unknownSize: 'आकार अज्ञात',
    free: 'खाली',
    used: 'भरा'
  }
}

function usePanelLang(): { lang: Lang; t: CleanerStrings } {
  const language = useSettingsStore((s) => s.settings.voice.language)
  const lang: Lang = language === 'hi' ? 'hi' : 'en'
  return { lang, t: STR[lang] }
}

/** A per-drive capacity gauge, colour-shifting toward red as it fills. */
function DiskGauge({ d, usedLabel, freeLabel }: { d: DriveUsage; usedLabel: string; freeLabel: string }): React.JSX.Element {
  const usedPct = d.totalBytes ? ((d.totalBytes - d.freeBytes) / d.totalBytes) * 100 : 0
  const danger = usedPct > 90
  return (
    <div className="min-w-[150px] flex-1 rounded-lg border border-white/5 bg-black/20 px-3 py-2">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[11px] font-bold text-body">
          {d.drive} <span className="text-dim">{d.label}</span>
        </span>
        <span className="font-mono text-[10px] text-dim">{usedPct.toFixed(0)}% {usedLabel}</span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{
            width: `${Math.min(100, usedPct)}%`,
            background: danger
              ? 'linear-gradient(90deg, #f59e0b, #ef4444)'
              : 'linear-gradient(90deg, var(--accent-dim), var(--accent))'
          }}
        />
      </div>
      <div className="mt-1 font-mono text-[10px] text-dim">
        {fmtBytes(d.freeBytes)} {freeLabel} · {fmtBytes(d.totalBytes)}
      </div>
    </div>
  )
}

function Checkbox({ on }: { on: boolean }): React.JSX.Element {
  return (
    <span
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors"
      style={{
        borderColor: on ? 'var(--accent)' : 'rgba(255,255,255,0.2)',
        background: on ? 'var(--accent)' : 'transparent'
      }}
    >
      {on && (
        <svg viewBox="0 0 12 12" className="h-3 w-3" style={{ color: 'var(--bg)' }}>
          <path d="M2 6.5 L5 9 L10 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  )
}

// ── Clean tab ───────────────────────────────────────────────────────
function CleanTab({ t }: { t: CleanerStrings }): React.JSX.Element {
  const { scan, scanning, selected, cleaning, lastFreed, runScan, toggleCategory, setAll, runClean } =
    useCleanerStore()

  const selectedBytes = useMemo(
    () => (scan?.categories ?? []).filter((c) => selected[c.id]).reduce((s, c) => s + c.bytes, 0),
    [scan, selected]
  )
  const selectedCount = (scan?.categories ?? []).filter((c) => selected[c.id]).length

  if (!scan && !scanning) {
    return (
      <EmptyState
        message={t.scanPrompt}
        action={<PrimaryButton onClick={() => void runScan()}>{t.scan}</PrimaryButton>}
      />
    )
  }

  return (
    <div className="flex h-full flex-col">
      {lastFreed != null && lastFreed > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          className="mx-4 mt-3 rounded-lg border px-3 py-2 font-ui text-xs"
          style={{ borderColor: 'var(--accent-dim)', background: 'color-mix(in srgb, var(--accent) 12%, transparent)', color: 'var(--accent)' }}
        >
          {t.freedBanner(fmtBytes(lastFreed))}
        </motion.div>
      )}

      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="font-mono text-[11px] text-dim">
          {scanning ? t.scanning : `${fmtBytes(scan?.totalBytes ?? 0)} ${t.reclaimable}`}
        </span>
        <div className="flex gap-2">
          <MiniButton onClick={() => setAll(true)}>{t.selectAll}</MiniButton>
          <MiniButton onClick={() => setAll(false)}>{t.clear}</MiniButton>
        </div>
      </div>

      <div className="smooth-scroll flex-1 overflow-y-auto px-4 pb-3">
        {scanning && !scan ? (
          <ScanningPulse label={t.scanning} />
        ) : (scan?.categories.length ?? 0) === 0 ? (
          <EmptyState message={t.allClean} />
        ) : (
          <div className="flex flex-col gap-1.5">
            {scan!.categories.map((c) => (
              <CategoryRow key={c.id} c={c} on={!!selected[c.id]} onToggle={() => toggleCategory(c.id)} itemsLabel={t.items} />
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-white/5 px-4 py-3">
        <span className="font-mono text-[11px] text-dim">
          {selectedCount} {t.selected} · {fmtBytes(selectedBytes)}
        </span>
        <div className="flex gap-2">
          <MiniButton onClick={() => void runScan()} disabled={scanning}>
            {scanning ? t.scanning : t.rescan}
          </MiniButton>
          <PrimaryButton onClick={() => void runClean()} disabled={cleaning || selectedCount === 0}>
            {cleaning ? t.cleaning : t.clean}
          </PrimaryButton>
        </div>
      </div>
    </div>
  )
}

function CategoryRow({
  c,
  on,
  onToggle,
  itemsLabel
}: {
  c: JunkCategory
  on: boolean
  onToggle: () => void
  itemsLabel: (n: number) => string
}): React.JSX.Element {
  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-3 rounded-lg border border-white/5 bg-black/20 px-3 py-2.5 text-left transition-colors hover:border-[var(--accent-dim)] hover:bg-white/5"
    >
      <Checkbox on={on} />
      <div className="min-w-0 flex-1">
        <div className="font-ui text-sm text-body">{c.label}</div>
        <div className="truncate font-mono text-[10px] text-dim">{c.hint}</div>
      </div>
      <div className="shrink-0 text-right">
        <div className="font-mono text-sm font-semibold text-body">{fmtBytes(c.bytes)}</div>
        <div className="font-mono text-[10px] text-dim">{itemsLabel(c.count)}</div>
      </div>
    </button>
  )
}

// ── Large files tab ─────────────────────────────────────────────────
function LargeTab({ t }: { t: CleanerStrings }): React.JSX.Element {
  const {
    largeFiles,
    largeScanning,
    largeScanned,
    minSizeMB,
    selectedFiles,
    setMinSizeMB,
    scanLargeFiles,
    toggleFile,
    deleteSelectedFiles
  } = useCleanerStore()

  const selectedCount = largeFiles.filter((f) => selectedFiles[f.path]).length
  const selectedBytes = largeFiles.filter((f) => selectedFiles[f.path]).reduce((s, f) => s + f.bytes, 0)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <label className="font-mono text-[11px] text-dim">{t.minSize}</label>
        <input
          type="number"
          value={minSizeMB}
          min={10}
          max={5000}
          step={10}
          onChange={(e) => setMinSizeMB(Number(e.target.value))}
          className="w-20 rounded-md border border-white/10 bg-black/30 px-2 py-1 font-mono text-xs text-body focus:border-[var(--accent-dim)] focus:outline-none"
        />
        <PrimaryButton onClick={() => void scanLargeFiles()} disabled={largeScanning}>
          {largeScanning ? t.scanning : t.findFiles}
        </PrimaryButton>
      </div>

      <div className="smooth-scroll flex-1 overflow-y-auto px-4 pb-3">
        {largeScanning ? (
          <ScanningPulse label={t.scanning} />
        ) : !largeScanned ? (
          <EmptyState message={t.largePrompt} />
        ) : largeFiles.length === 0 ? (
          <EmptyState message={t.noLarge} />
        ) : (
          <div className="flex flex-col gap-1.5">
            {largeFiles.map((f) => (
              <LargeFileRow
                key={f.path}
                f={f}
                on={!!selectedFiles[f.path]}
                onToggle={() => toggleFile(f.path)}
                idleLabel={t.idle}
                revealLabel={t.reveal}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-white/5 px-4 py-3">
        <span className="font-mono text-[11px] text-dim">
          {selectedCount ? `${selectedCount} · ${fmtBytes(selectedBytes)}` : t.recoverable}
        </span>
        <DangerButton onClick={() => void deleteSelectedFiles()} disabled={selectedCount === 0}>
          {t.deleteSel}
          {selectedCount > 0 ? ` (${selectedCount})` : ''}
        </DangerButton>
      </div>
    </div>
  )
}

function LargeFileRow({
  f,
  on,
  onToggle,
  idleLabel,
  revealLabel
}: {
  f: LargeFile
  on: boolean
  onToggle: () => void
  idleLabel: (d: number) => string
  revealLabel: string
}): React.JSX.Element {
  const stale = f.idleDays >= 90
  return (
    <div className="flex items-center gap-3 rounded-lg border border-white/5 bg-black/20 px-3 py-2.5">
      <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <Checkbox on={on} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-ui text-sm text-body">{f.name}</div>
          <div className="truncate font-mono text-[10px] text-dim">{f.path}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-sm font-semibold text-body">{fmtBytes(f.bytes)}</div>
          <div className="font-mono text-[10px]" style={{ color: stale ? '#f59e0b' : 'var(--dim, #7a8699)' }}>
            {idleLabel(f.idleDays)}
          </div>
        </div>
      </button>
      <button
        onClick={() => void window.cosmos.cleaner.reveal(f.path)}
        className="shrink-0 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-dim hover:bg-white/5 hover:text-body"
        title={f.path}
      >
        {revealLabel}
      </button>
    </div>
  )
}

// ── Apps / uninstall tab ────────────────────────────────────────────
function AppsTab({ t }: { t: CleanerStrings }): React.JSX.Element {
  const { programs, programsLoading, programsLoaded, uninstallingId, loadPrograms, uninstall } =
    useCleanerStore()
  const [query, setQuery] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => {
    if (!programsLoaded && !programsLoading) void loadPrograms()
  }, [programsLoaded, programsLoading, loadPrograms])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return programs
    return programs.filter((p) => p.name.toLowerCase().includes(q) || p.publisher.toLowerCase().includes(q))
  }, [programs, query])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.searchApps}
          className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-3 py-1.5 font-ui text-sm text-body placeholder:text-dim focus:border-[var(--accent-dim)] focus:outline-none"
        />
        <span className="font-mono text-[10px] text-dim">{filtered.length}</span>
        <MiniButton onClick={() => void loadPrograms()} disabled={programsLoading}>
          {t.refresh}
        </MiniButton>
      </div>

      <div className="smooth-scroll flex-1 overflow-y-auto px-4 pb-3">
        {programsLoading && programs.length === 0 ? (
          <ScanningPulse label={t.loadingApps} />
        ) : filtered.length === 0 ? (
          <EmptyState message={t.noApps} />
        ) : (
          <div className="flex flex-col gap-1.5">
            {filtered.map((p) => (
              <ProgramRow
                key={p.id}
                p={p}
                busy={uninstallingId === p.id}
                confirming={confirmId === p.id}
                onAsk={() => setConfirmId(p.id)}
                onCancel={() => setConfirmId(null)}
                onConfirm={() => {
                  setConfirmId(null)
                  void uninstall(p)
                }}
                t={t}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ProgramRow({
  p,
  busy,
  confirming,
  onAsk,
  onCancel,
  onConfirm,
  t
}: {
  p: InstalledProgram
  busy: boolean
  confirming: boolean
  onAsk: () => void
  onCancel: () => void
  onConfirm: () => void
  t: CleanerStrings
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-white/5 bg-black/20 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate font-ui text-sm text-body">{p.name}</div>
        <div className="truncate font-mono text-[10px] text-dim">
          {p.bytes ? fmtBytes(p.bytes) : t.unknownSize}
          {p.publisher ? ` · ${p.publisher}` : ''}
          {p.version ? ` · v${p.version}` : ''}
        </div>
      </div>
      {confirming ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={onConfirm}
            className="rounded-md px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors"
            style={{ background: 'rgba(239,68,68,0.2)', color: '#fca5a5' }}
          >
            {t.confirm}
          </button>
          <button
            onClick={onCancel}
            className="rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-dim hover:bg-white/5 hover:text-body"
          >
            ✕
          </button>
        </div>
      ) : (
        <button
          onClick={onAsk}
          disabled={busy}
          className="shrink-0 rounded-md border border-white/10 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-dim transition-colors hover:border-red-400/40 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40"
        >
          {busy ? t.uninstalling : t.uninstall}
        </button>
      )}
    </div>
  )
}

// ── shared bits ─────────────────────────────────────────────────────
function PrimaryButton({
  children,
  onClick,
  disabled
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-md px-4 py-1.5 font-mono text-[11px] font-bold uppercase tracking-widest transition-all disabled:cursor-not-allowed disabled:opacity-40"
      style={{ background: 'var(--accent)', color: 'var(--bg)' }}
    >
      {children}
    </button>
  )
}

function DangerButton({
  children,
  onClick,
  disabled
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-md px-4 py-1.5 font-mono text-[11px] font-bold uppercase tracking-widest transition-all disabled:cursor-not-allowed disabled:opacity-40"
      style={{ background: 'rgba(239,68,68,0.9)', color: '#fff' }}
    >
      {children}
    </button>
  )
}

function MiniButton({
  children,
  onClick,
  disabled
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-dim transition-colors hover:bg-white/5 hover:text-body disabled:opacity-40"
    >
      {children}
    </button>
  )
}

function EmptyState({ message, action }: { message: string; action?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-4 px-8 text-center">
      <p className="max-w-sm font-ui text-sm text-dim">{message}</p>
      {action}
    </div>
  )
}

function ScanningPulse({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-4">
      <motion.div
        className="h-12 w-12 rounded-full border-2"
        style={{ borderColor: 'var(--accent-dim)', borderTopColor: 'var(--accent)' }}
        animate={{ rotate: 360 }}
        transition={{ repeat: Infinity, duration: 0.9, ease: 'linear' }}
      />
      <p className="font-mono text-xs text-dim">{label}</p>
    </div>
  )
}

/**
 * The System Cleaner: a premium, CCleaner-grade maintenance window. Scans and
 * clears safe junk, surfaces large/idle files to delete, and uninstalls apps —
 * all backed by the guarded CleanerService and mirrored to the assistant's
 * cleaner_* tools, so voice/chat and this UI drive one safe engine.
 */
export function CleanerPanel(): React.JSX.Element {
  const activePanel = useUIStore((s) => s.activePanel)
  const setPanel = useUIStore((s) => s.setPanel)
  const open = activePanel === 'cleaner'
  const { lang, t } = usePanelLang()

  const [tab, setTab] = useState<Tab>('clean')
  const scan = useCleanerStore((s) => s.scan)
  const scanning = useCleanerStore((s) => s.scanning)
  const disks = useCleanerStore((s) => s.disks)
  const runScan = useCleanerStore((s) => s.runScan)
  const loadDisks = useCleanerStore((s) => s.loadDisks)

  useEffect(() => {
    if (!open) return
    void loadDisks()
    if (!scan && !scanning) void runScan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const askCosmos = (): void => {
    setPanel('none')
    const prompt =
      lang === 'hi'
        ? 'मेरे पीसी को स्कैन करके बताओ कि मैं सुरक्षित रूप से क्या साफ़ कर सकता/सकती हूँ, कौन सी बड़ी फ़ाइलें डिलीट करके जगह बना सकता/सकती हूँ, और कौन से ऐप्स अनइंस्टॉल करने लायक हैं।'
        : 'Scan my PC — tell me what junk I can safely clean, which large files I could delete to free space, and any apps worth uninstalling.'
    void useAssistantStore.getState().send(prompt)
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-30 flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)' }}
          onClick={() => setPanel('none')}
        >
          <motion.div
            initial={{ scale: 0.97, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.98, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <Glass brackets className="flex h-[640px] w-[960px] flex-col overflow-hidden">
              {/* header */}
              <div className="flex items-center gap-3 border-b border-white/5 px-5 py-3">
                <span className="font-display text-[10px] font-bold uppercase tracking-[0.3em] text-body">
                  {t.title}
                </span>
                <span className="font-mono text-[10px] text-dim">{t.subtitle}</span>
                <div className="flex-1" />
                <button
                  onClick={askCosmos}
                  className="rounded-md border border-white/10 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-dim transition-colors hover:border-[var(--accent-dim)] hover:text-body"
                  title={t.ask}
                >
                  ✦ {t.ask}
                </button>
                <button
                  onClick={() => setPanel('none')}
                  className="rounded-md px-2 py-1 font-mono text-xs text-dim hover:bg-white/5 hover:text-body"
                >
                  ESC
                </button>
              </div>

              {/* disk gauges */}
              {disks.length > 0 && (
                <div className="flex gap-2.5 border-b border-white/5 px-5 py-3">
                  {disks.map((d) => (
                    <DiskGauge key={d.drive} d={d} usedLabel={t.used} freeLabel={t.free} />
                  ))}
                </div>
              )}

              {/* tabs */}
              <div className="flex gap-1 border-b border-white/5 px-4 pt-2">
                {(['clean', 'large', 'apps'] as Tab[]).map((id) => (
                  <button
                    key={id}
                    onClick={() => setTab(id)}
                    className="relative px-3 py-2 font-mono text-[11px] uppercase tracking-widest transition-colors"
                    style={{ color: tab === id ? 'var(--accent)' : undefined }}
                  >
                    <span className={tab === id ? '' : 'text-dim hover:text-body'}>{t.tabs[id]}</span>
                    {tab === id && (
                      <motion.div
                        layoutId="cleaner-tab-underline"
                        className="absolute inset-x-2 -bottom-px h-0.5 rounded-full"
                        style={{ background: 'var(--accent)' }}
                      />
                    )}
                  </button>
                ))}
              </div>

              {/* body */}
              <div className="min-h-0 flex-1">
                {tab === 'clean' && <CleanTab t={t} />}
                {tab === 'large' && <LargeTab t={t} />}
                {tab === 'apps' && <AppsTab t={t} />}
              </div>
            </Glass>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
