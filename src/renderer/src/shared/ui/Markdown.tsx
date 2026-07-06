import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'

/** open links in the user's real browser, never inside the app window */
function openExternal(url?: string): void {
  if (url && /^https?:\/\//.test(url)) void window.cosmos.commands.run('open-url', url)
}

const components: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault()
        openExternal(href)
      }}
      className="cursor-pointer underline decoration-[var(--accent-dim)] underline-offset-2 transition-colors hover:decoration-[var(--accent)]"
      style={{ color: 'var(--accent-bright)' }}
    >
      {children}
    </a>
  ),
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 ml-4 list-disc space-y-1 marker:text-dim">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 ml-4 list-decimal space-y-1 marker:text-dim">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-body">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  h1: ({ children }) => <h1 className="mb-1.5 mt-2 font-display text-base font-bold text-body first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1 mt-2 font-display text-sm font-bold text-body first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-1.5 font-ui text-sm font-semibold text-body first:mt-0">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 pl-3 text-dim" style={{ borderColor: 'var(--accent-dim)' }}>
      {children}
    </blockquote>
  ),
  code: ({ className, children }) => {
    const isBlock = /language-/.test(className ?? '')
    if (isBlock) {
      return (
        <code className="block overflow-x-auto rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-[12px] leading-relaxed text-body">
          {children}
        </code>
      )
    }
    return (
      <code className="rounded border border-white/10 bg-black/30 px-1 py-0.5 font-mono text-[12px] text-[var(--accent-bright)]">
        {children}
      </code>
    )
  },
  pre: ({ children }) => <pre className="my-2 first:mt-0 last:mb-0">{children}</pre>,
  hr: () => <hr className="my-2 border-white/10" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-white/10 px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-white/10 px-2 py-1">{children}</td>
}

/**
 * Renders assistant messages as clean, formatted text — bold, lists,
 * code, tables and clickable links — instead of raw markdown syntax.
 */
export const Markdown = memo(function Markdown({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="cosmos-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
})
