import { create } from 'zustand'
import type {
  CleanScanResult,
  DriveUsage,
  InstalledProgram,
  LargeFile
} from '@shared/types'
import { useNotificationStore } from '@/core/stores/useNotificationStore'
import { sound } from '@/core/sound/SoundEngine'

const notify = (
  title: string,
  body: string,
  kind: 'info' | 'success' | 'error' = 'info'
): void => useNotificationStore.getState().push({ title, body, kind })

interface CleanerStore {
  // ── junk / clean ──
  scan: CleanScanResult | null
  scanning: boolean
  /** categoryId → ticked for cleaning */
  selected: Record<string, boolean>
  cleaning: boolean
  /** bytes reclaimed by the most recent clean (for the success banner) */
  lastFreed: number | null
  runScan: () => Promise<void>
  toggleCategory: (id: string) => void
  setAll: (value: boolean) => void
  runClean: () => Promise<void>

  // ── disk usage ──
  disks: DriveUsage[]
  loadDisks: () => Promise<void>

  // ── large files ──
  largeFiles: LargeFile[]
  largeScanning: boolean
  largeScanned: boolean
  minSizeMB: number
  selectedFiles: Record<string, boolean>
  setMinSizeMB: (n: number) => void
  scanLargeFiles: () => Promise<void>
  toggleFile: (path: string) => void
  deleteSelectedFiles: () => Promise<void>

  // ── installed programs ──
  programs: InstalledProgram[]
  programsLoading: boolean
  programsLoaded: boolean
  uninstallingId: string | null
  loadPrograms: () => Promise<void>
  uninstall: (program: InstalledProgram) => Promise<void>
}

export const useCleanerStore = create<CleanerStore>((set, get) => ({
  scan: null,
  scanning: false,
  selected: {},
  cleaning: false,
  lastFreed: null,

  runScan: async () => {
    if (get().scanning) return
    set({ scanning: true, lastFreed: null })
    try {
      const scan = await window.cosmos.cleaner.scan()
      // pre-tick every recommended (known-safe) category
      const selected: Record<string, boolean> = {}
      for (const c of scan.categories) selected[c.id] = c.recommended
      set({ scan, selected })
    } catch (err) {
      notify('Scan failed', err instanceof Error ? err.message : String(err), 'error')
    } finally {
      set({ scanning: false })
    }
  },

  toggleCategory: (id) =>
    set((s) => ({ selected: { ...s.selected, [id]: !s.selected[id] } })),

  setAll: (value) =>
    set((s) => {
      const selected: Record<string, boolean> = {}
      for (const c of s.scan?.categories ?? []) selected[c.id] = value
      return { selected }
    }),

  runClean: async () => {
    const { scan, selected, cleaning } = get()
    if (!scan || cleaning) return
    const ids = scan.categories.filter((c) => selected[c.id]).map((c) => c.id)
    if (!ids.length) {
      notify('Nothing selected', 'Tick at least one category to clean.', 'info')
      return
    }
    set({ cleaning: true })
    try {
      const res = await window.cosmos.cleaner.clean(ids)
      set({ lastFreed: res.freedBytes })
      sound.play('success')
      notify(
        'Cleanup complete',
        res.freedBytes > 0 ? `Reclaimed ${fmtBytes(res.freedBytes)}.` : 'Everything was already clear.',
        'success'
      )
      // re-scan so the numbers reflect the now-clean state
      await get().runScan()
      await get().loadDisks()
    } catch (err) {
      notify('Cleanup failed', err instanceof Error ? err.message : String(err), 'error')
    } finally {
      set({ cleaning: false })
    }
  },

  disks: [],
  loadDisks: async () => {
    try {
      set({ disks: await window.cosmos.cleaner.diskUsage() })
    } catch {
      /* non-critical — the gauge just stays empty */
    }
  },

  largeFiles: [],
  largeScanning: false,
  largeScanned: false,
  minSizeMB: 100,
  selectedFiles: {},
  setMinSizeMB: (n) => set({ minSizeMB: Math.max(10, Math.min(5000, Math.round(n) || 100)) }),

  scanLargeFiles: async () => {
    if (get().largeScanning) return
    set({ largeScanning: true })
    try {
      const files = await window.cosmos.cleaner.largeFiles(get().minSizeMB, 80)
      set({ largeFiles: files, selectedFiles: {}, largeScanned: true })
    } catch (err) {
      notify('Scan failed', err instanceof Error ? err.message : String(err), 'error')
    } finally {
      set({ largeScanning: false })
    }
  },

  toggleFile: (path) =>
    set((s) => ({ selectedFiles: { ...s.selectedFiles, [path]: !s.selectedFiles[path] } })),

  deleteSelectedFiles: async () => {
    const { largeFiles, selectedFiles } = get()
    const paths = largeFiles.filter((f) => selectedFiles[f.path]).map((f) => f.path)
    if (!paths.length) {
      notify('Nothing selected', 'Tick the files you want to move to the Recycle Bin.', 'info')
      return
    }
    try {
      const results = await window.cosmos.cleaner.delete(paths, false)
      const ok = results.filter((r) => r.ok)
      const failed = results.filter((r) => !r.ok)
      if (ok.length) {
        sound.play('success')
        notify(
          'Moved to Recycle Bin',
          `${ok.length} file${ok.length === 1 ? '' : 's'} removed (recoverable).`,
          'success'
        )
      }
      if (failed.length) {
        notify('Some files were kept', failed[0].message, 'error')
      }
      // drop the deleted ones from the list
      const okSet = new Set(ok.map((r) => r.path))
      set((s) => ({
        largeFiles: s.largeFiles.filter((f) => !okSet.has(f.path)),
        selectedFiles: {}
      }))
      await get().loadDisks()
    } catch (err) {
      notify('Delete failed', err instanceof Error ? err.message : String(err), 'error')
    }
  },

  programs: [],
  programsLoading: false,
  programsLoaded: false,
  uninstallingId: null,

  loadPrograms: async () => {
    if (get().programsLoading) return
    set({ programsLoading: true })
    try {
      set({ programs: await window.cosmos.cleaner.programs(), programsLoaded: true })
    } catch (err) {
      notify('Could not read programs', err instanceof Error ? err.message : String(err), 'error')
    } finally {
      set({ programsLoading: false })
    }
  },

  uninstall: async (program) => {
    if (get().uninstallingId) return
    set({ uninstallingId: program.id })
    try {
      const res = await window.cosmos.cleaner.uninstall(program.id)
      if (res.ok) {
        notify('Uninstaller started', res.message, 'success')
      } else {
        notify('Uninstall failed', res.message, 'error')
      }
    } catch (err) {
      notify('Uninstall failed', err instanceof Error ? err.message : String(err), 'error')
    } finally {
      set({ uninstallingId: null })
    }
  }
}))

/** Human-readable size (shared with the panel). */
export function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} TB`
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${Math.round(bytes)} B`
}
