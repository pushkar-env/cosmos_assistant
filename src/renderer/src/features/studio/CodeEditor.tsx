import { useEffect, useRef } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { oneDark } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'

/** pick a CodeMirror language extension from a file name */
function langFor(name: string): Extension[] {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return [javascript({ jsx: true })]
    case 'ts':
      return [javascript({ typescript: true })]
    case 'tsx':
      return [javascript({ typescript: true, jsx: true })]
    case 'py':
      return [python()]
    case 'html':
    case 'htm':
    case 'vue':
    case 'svelte':
      return [html()]
    case 'css':
    case 'scss':
    case 'less':
      return [css()]
    case 'json':
      return [json()]
    case 'md':
    case 'markdown':
      return [markdown()]
    default:
      return []
  }
}

interface Props {
  path: string
  value: string
  readOnly?: boolean
  onChange: (content: string) => void
  onSave: () => void
}

/**
 * A CodeMirror 6 editor. Remounts on file switch (keyed by path) and keeps in
 * sync when the underlying file changes on disk (e.g. an agent edit).
 */
export function CodeEditor({ path, value, readOnly, onChange, onSave }: Props): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const save = useRef(onSave)
  const change = useRef(onChange)
  save.current = onSave
  change.current = onChange

  useEffect(() => {
    if (!host.current) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        oneDark,
        ...langFor(path),
        EditorView.editable.of(!readOnly),
        EditorState.readOnly.of(!!readOnly),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              save.current()
              return true
            }
          }
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) change.current(u.state.doc.toString())
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '13px' },
          '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
          '.cm-content': { paddingBottom: '40vh' }
        })
      ]
    })
    const editor = new EditorView({ state, parent: host.current })
    view.current = editor
    editor.focus()
    return () => {
      editor.destroy()
      view.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, readOnly])

  // external content change (disk reload) → replace doc without losing the view
  useEffect(() => {
    const editor = view.current
    if (editor && value !== editor.state.doc.toString()) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } })
    }
  }, [value])

  return <div ref={host} className="h-full w-full overflow-hidden" />
}
