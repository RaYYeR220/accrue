import { useEffect, useRef, type HTMLAttributes, type ReactNode } from 'react'

type CardTone = 'plain' | 'quiet' | 'wash'

// Surfaces are hairlines on the ground, never shadows.
export function Card({ tone = 'plain', className, ...rest }: { tone?: CardTone } & HTMLAttributes<HTMLDivElement>) {
  return <div className={['card', `card-${tone}`, className ?? ''].filter(Boolean).join(' ')} {...rest} />
}

// A bottom sheet on a native modal <dialog>: focus moves in and is trapped, Escape and a tap on
// the backdrop close it. It only ever opens from a tap, never on load.
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-label={title}
      onCancel={e => {
        e.preventDefault()
        onClose()
      }}
      onClick={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="sheet-body">
        <span className="sheet-handle" aria-hidden="true" />
        <h2 className="sheet-title">{title}</h2>
        {children}
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </dialog>
  )
}
