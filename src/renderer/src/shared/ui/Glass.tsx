import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'

interface GlassProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  brackets?: boolean
  hover?: boolean
}

/** The one true panel surface. Every floating element uses this. */
export const Glass = forwardRef<HTMLDivElement, GlassProps>(function Glass(
  { children, brackets = false, hover = false, className = '', ...rest },
  ref
) {
  const classes = [
    'glass',
    brackets ? 'brackets' : '',
    hover ? 'glass-hover' : '',
    className
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div ref={ref} className={classes} {...rest}>
      {children}
    </div>
  )
})
