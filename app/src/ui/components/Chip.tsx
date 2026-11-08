import type { ButtonHTMLAttributes, ReactNode } from 'react'

// A pill toggle. It looks --chip-h tall but its hit area is always --tap (44 px).
export function Chip({
  pressed,
  className,
  children,
  ...rest
}: { pressed?: boolean; children: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'>) {
  return (
    <button type="button" className={['chip', className ?? ''].filter(Boolean).join(' ')} aria-pressed={pressed} {...rest}>
      {children}
    </button>
  )
}
