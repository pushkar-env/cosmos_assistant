interface StatusDotProps {
  active?: boolean
  color?: string
}

export function StatusDot({ active = true, color }: StatusDotProps): React.JSX.Element {
  return (
    <span
      className="inline-block h-1.5 w-1.5 rounded-full transition-all duration-300"
      style={{
        background: color ?? 'var(--accent)',
        boxShadow: active ? `0 0 8px 1px ${color ?? 'var(--glow)'}` : 'none',
        opacity: active ? 1 : 0.3
      }}
    />
  )
}
