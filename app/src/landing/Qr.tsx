import { useEffect, useState } from 'react'

// The encoder is loaded only when a QR code is actually shown (desktop), never on phones.
function toPath(data: boolean[][]): string {
  let d = ''
  data.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      if (!row[x]) {
        x++
        continue
      }
      const start = x
      while (x < row.length && row[x]) x++
      d += `M${start} ${y}h${x - start}v1h${start - x}z`
    }
  })
  return d
}

export function Qr({ text, label, className }: { text: string; label: string; className?: string }) {
  const [qr, setQr] = useState<{ size: number; path: string } | null>(null)

  useEffect(() => {
    let live = true
    void import('uqr').then(({ encode }) => {
      if (!live) return
      const { data, size } = encode(text, { ecc: 'M', border: 2 })
      setQr({ size, path: toPath(data) })
    })
    return () => {
      live = false
    }
  }, [text])

  return (
    <div className={['qr', className ?? ''].filter(Boolean).join(' ')}>
      {qr ? (
        <svg viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label={label} shapeRendering="crispEdges">
          <path d={qr.path} fill="currentColor" />
        </svg>
      ) : (
        <span className="qr-wait" role="img" aria-label={label} />
      )}
    </div>
  )
}
