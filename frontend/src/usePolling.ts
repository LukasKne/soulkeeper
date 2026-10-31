import { useCallback, useEffect, useRef, useState } from 'react'

export function usePolling<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const refresh = useCallback(async () => {
    const current = ++sequence.current
    controller.current?.abort()
    const next = new AbortController(); controller.current = next
    try {
      const result = await load(next.signal)
      if (current === sequence.current) { setData(result); setError('') }
    } catch (err) {
      if (current === sequence.current && !(err instanceof DOMException && err.name === 'AbortError')) {
        setData(null); setError(err instanceof Error ? err.message : 'Could not load this view.')
      }
    }
  }, [load])
  useEffect(() => {
    setData(null); setError(''); void refresh()
    const visible = () => { if (document.visibilityState === 'visible') void refresh() }
    const timer = window.setInterval(visible, 5000)
    window.addEventListener('focus', visible)
    document.addEventListener('visibilitychange', visible)
    return () => { ++sequence.current; controller.current?.abort(); clearInterval(timer); window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible) }
  }, [refresh])
  return { data, error, refresh }
}
