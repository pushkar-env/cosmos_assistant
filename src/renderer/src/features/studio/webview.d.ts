import 'react'

/**
 * Electron's <webview> tag isn't part of React's built-in JSX intrinsics.
 * Declare a minimal typed surface for the props + methods Studio's preview uses.
 */
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string
        allowpopups?: string
        partition?: string
        useragent?: string
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ref?: React.Ref<any>
      }
    }
  }
}

/** the subset of Electron's WebviewTag DOM API the preview pane calls */
export interface WebviewEl extends HTMLElement {
  src: string
  reload(): void
  stop(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  loadURL(url: string): Promise<void>
  getURL(): string
}
