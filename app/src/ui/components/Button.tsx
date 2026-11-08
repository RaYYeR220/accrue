import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'ghost' | 'quiet'

interface Common {
  variant?: ButtonVariant
  block?: boolean
  children: ReactNode
}

const cls = (variant: ButtonVariant, block: boolean | undefined, extra: string | undefined) =>
  ['btn', `btn-${variant}`, block ? 'btn-block' : '', extra ?? ''].filter(Boolean).join(' ')

export function Button({ variant = 'primary', block, className, type = 'button', ...rest }: Common & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={cls(variant, block, className)} {...rest} />
}

export function ButtonLink({ variant = 'primary', block, className, ...rest }: Common & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a className={cls(variant, block, className)} {...rest} />
}
