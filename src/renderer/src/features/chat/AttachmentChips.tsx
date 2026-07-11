import type { Attachment } from '@shared/types'
import { formatSize, imageDataUrl } from './attachments'

const KIND_ICON: Record<Attachment['kind'], string> = {
  image: '🖼️',
  pdf: '📄',
  text: '📃'
}

/**
 * Renders a row of attachment chips — image thumbnails and document pills.
 * With `onRemove` it's the removable composer tray; without, it's the
 * read-only strip shown on a sent message.
 */
export function AttachmentChips({
  attachments,
  onRemove
}: {
  attachments: Attachment[]
  onRemove?: (id: string) => void
}): React.JSX.Element | null {
  if (attachments.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {attachments.map((a) => (
        <div
          key={a.id}
          title={`${a.name} · ${formatSize(a.size)}`}
          className="group relative flex items-center gap-1.5 overflow-hidden rounded-lg border border-white/10 bg-black/30 py-1 pl-1 pr-2"
        >
          {a.kind === 'image' && a.data ? (
            <img
              src={imageDataUrl(a)}
              alt={a.name}
              className="h-7 w-7 shrink-0 rounded object-cover"
            />
          ) : (
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded bg-white/5 text-sm">
              {KIND_ICON[a.kind]}
            </span>
          )}
          <span className="max-w-[120px] truncate font-ui text-[11px] text-body">{a.name}</span>
          {onRemove && (
            <button
              onClick={() => onRemove(a.id)}
              title="Remove"
              className="ml-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-white/10 font-mono text-[10px] leading-none text-dim transition-colors hover:bg-red-500/30 hover:text-red-200"
            >
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
