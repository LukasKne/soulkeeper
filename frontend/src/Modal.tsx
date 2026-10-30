import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'

export default function Modal({ title, children, onClose, busy }: { title: string; children: ReactNode; onClose: () => void; busy: boolean }) {
  const id = useId()
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  const busyRef = useRef(busy)
  closeRef.current = onClose
  busyRef.current = busy
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null
    const bodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    ref.current?.querySelector<HTMLElement>('input, select, button')?.focus()
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) closeRef.current()
      if (event.key !== 'Tab') return
      const items = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')
      if (!items?.length) { event.preventDefault(); return }
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handler)
    return () => { document.body.style.overflow = bodyOverflow; document.removeEventListener('keydown', handler); prior?.focus() }
  }, [])
  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
      <button className="icon-button modal-close" aria-label="Close dialog" disabled={busy} onClick={onClose}><span aria-hidden="true">×</span></button>
      <div className="modal-emblem" aria-hidden="true">✦</div>
      <h2 id={id}>{title}</h2>{children}
    </div>
  </div>
}
