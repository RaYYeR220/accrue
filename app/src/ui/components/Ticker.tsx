import { useEffect, useRef } from 'react'

// A live figure where only the digits that changed roll; the rest stay still. Each character is
// keyed by its position and value, so a changed digit mounts fresh and plays the roll once.
export function Ticker({ text, className }: { text: string; className?: string }) {
  const prev = useRef<string | null>(null)
  const before = prev.current
  useEffect(() => {
    prev.current = text
  }, [text])
  // align from the right, so "9.99 → 10.00" compares units with units
  const shift = before === null ? 0 : before.length - text.length
  return (
    <span className={['ticker', className ?? ''].filter(Boolean).join(' ')}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {[...text].map((c, i) => {
          const was = before?.[i + shift]
          const roll = before !== null && was !== c && /\d/.test(c)
          return (
            <span key={`${text.length - i}:${c}`} className={roll ? 'tk tk-roll' : 'tk'}>
              {c}
            </span>
          )
        })}
      </span>
    </span>
  )
}
