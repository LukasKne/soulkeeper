import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from './api'
import Checklist from './Checklist'
import Modal from './Modal'
import { displayName, historyCompare, PageLink, savedDate, ScoreLine } from './RunPages'
import type { Encounter, PracticeSummary, PracticeView, Session } from './types'

type Confirmation = { kind: 'reset' | 'delete'; id: string } | { kind: 'delete-all' }
const message = (error: unknown) => error instanceof Error ? error.message : 'Could not update practice. Please try again.'

export default function Practice({ session, historyId, navigate, onLogin }: { session: Session; historyId?: string; navigate: (path: string) => void; onLogin: () => void }) {
  const [draft, setDraft] = useState<PracticeView | null>(null)
  const [record, setRecord] = useState<PracticeView | null>(null)
  const [history, setHistory] = useState<PracticeSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [readError, setReadError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [pending, setPending] = useState<{ id: string; defeated: boolean } | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const sequence = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const refresh = useCallback(async (open = false) => {
    if (!session.user || inFlight.current) return
    const current = ++sequence.current
    controller.current?.abort()
    const next = new AbortController(); controller.current = next
    try {
      const [nextDraft, nextHistory, nextRecord] = await Promise.all([
        api<PracticeView>('/practice', { signal: next.signal }).catch(err => {
          if (open && err instanceof ApiError && err.status === 404) return api<PracticeView>('/practice', { method: 'POST', csrf: session.csrf_token, signal: next.signal })
          throw err
        }),
        api<{ attempts: PracticeSummary[] }>('/practice/history', { signal: next.signal }),
        historyId ? api<PracticeView>(`/practice/history/${encodeURIComponent(historyId)}`, { signal: next.signal }).catch(err => {
          if (err instanceof ApiError && err.status === 404) return null
          throw err
        }) : Promise.resolve(null),
      ])
      if (current !== sequence.current || !mounted.current) return
      setDraft(nextDraft); setHistory(nextHistory.attempts); setRecord(nextRecord); setReadError(historyId && !nextRecord ? 'Saved practice not found. It may have been deleted.' : '')
    } catch (err) {
      if (current === sequence.current && mounted.current && !(err instanceof DOMException && err.name === 'AbortError')) { setReadError(message(err)); if (historyId) setRecord(null) }
    } finally { if (current === sequence.current && mounted.current) setLoading(false) }
  }, [session.user?.username, session.csrf_token, historyId])
  useEffect(() => {
    mounted.current = true
    void refresh(true)
    const visible = () => { if (document.visibilityState === 'visible') void refresh() }
    const timer = window.setInterval(visible, 5000)
    window.addEventListener('focus', visible); document.addEventListener('visibilitychange', visible)
    return () => { mounted.current = false; ++sequence.current; controller.current?.abort(); clearInterval(timer); window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible) }
  }, [refresh])

  async function mutate(action: string, operation: () => Promise<void>) {
    if (inFlight.current) return
    inFlight.current = true; ++sequence.current; controller.current?.abort()
    setBusy(action); setError(''); setNotice('')
    try { await operation() }
    catch (err) { if (mounted.current) setError(message(err)) }
    finally {
      inFlight.current = false
      if (mounted.current) { setBusy(null); setPending(null); setConfirmation(null); await refresh() }
    }
  }
  function toggle(entry: Encounter) {
    if (!draft || inFlight.current) return
    const id = draft.id
    setPending({ id: entry.id, defeated: !entry.defeated })
    void mutate(entry.id, async () => { const result = await api<PracticeView>(`/practice/${id}/encounters/${encodeURIComponent(entry.id)}`, { method: 'PUT', body: { defeated: !entry.defeated }, csrf: session.csrf_token }); if (mounted.current) setDraft(result) })
  }
  function save(outcome: 'died' | 'ended') {
    if (!draft) return
    const id = draft.id
    void mutate(outcome, async () => {
      const result = await api<{ draft: PracticeView; saved: PracticeSummary }>(`/practice/${id}/save`, { method: 'POST', body: { outcome }, csrf: session.csrf_token })
      if (mounted.current) { setDraft(result.draft); setNotice('Practice saved to your private history. Your new checklist is ready.') }
    })
  }
  function confirm() {
    const action = confirmation
    if (!action) return
    void mutate(action.kind, async () => {
      if (action.kind === 'reset') {
        const result = await api<PracticeView>(`/practice/${action.id}/reset`, { method: 'POST', csrf: session.csrf_token })
        if (mounted.current) { setDraft(result); setNotice('Practice reset. No history entry was saved.') }
      } else {
        await api(`/practice/history${action.kind === 'delete' ? `/${encodeURIComponent(action.id)}` : ''}`, { method: 'DELETE', csrf: session.csrf_token })
        if (mounted.current) {
          setNotice(action.kind === 'delete-all' ? 'Your saved practice history was deleted.' : 'Saved practice deleted.')
          if (historyId && (action.kind === 'delete-all' || action.id === historyId)) navigate('/practice')
        }
      }
    })
  }

  if (!session.user) return <section className="run-page empty-panel"><h2>Private practice</h2><p>Sign in to keep a personal checklist and saved practice history.</p><button className="button button-gold" onClick={onLogin}>Player login</button></section>
  const shown = historyId ? record : draft
  const confirmationTitle = confirmation?.kind === 'reset' ? 'Reset all practice progress?' : confirmation?.kind === 'delete-all' ? 'Delete all practice history?' : 'Delete saved practice?'
  return <section className="run-page" aria-labelledby="practice-title">
    <div className="section-heading"><div><p className="eyebrow">PRIVATE · {displayName(session.user.username)}</p><h2 id="practice-title">{historyId ? 'Saved practice' : 'Practice'}</h2></div>{historyId ? <PageLink to="/practice" navigate={navigate}>Back to practice →</PageLink> : <a className="text-button" href="#practice-history-title">Saved history ({history.length}) ↓</a>}</div>
    <p className="section-description">Check encounters freely. Died or End saves a private snapshot and starts fresh. Reset all clears the draft without saving history.</p>
    {(error || readError) && <div className="error-banner" role="alert">{error || readError}<button className="text-button" onClick={() => { setError(''); void refresh(true) }}>Refresh</button></div>}
    {notice && <div className="success-banner" role="status">{notice}</div>}
    {loading && !shown ? <p role="status">Opening practice…</p> : shown ? <>
      <div className="personal-summary practice-summary"><ScoreLine {...shown}/><div className="run-actions">{historyId ? <><span>{shown.outcome === 'died' ? 'Died' : 'Ended'} · {shown.saved_at && savedDate(shown.saved_at)}</span><PageLink to={historyCompare(session.user.username, `practice:${shown.id}`)} navigate={navigate}>Compare →</PageLink><button className="button button-outline button-small" disabled={Boolean(busy)} onClick={() => setConfirmation({ kind: 'delete', id: shown.id })}>Delete</button></> : <><span className="save-state" role="status">{busy && pending ? 'Saving…' : 'Private draft saved automatically'}</span><button className="button button-outline button-small" disabled={Boolean(busy) || Boolean(readError)} onClick={() => save('ended')}>End</button><button className="button button-danger button-small" disabled={Boolean(busy) || Boolean(readError)} onClick={() => save('died')}>Died</button><button className="button button-outline button-small" disabled={Boolean(busy) || Boolean(readError)} onClick={() => setConfirmation({ kind: 'reset', id: shown.id })}>Reset all</button></>}</div></div>
      <Checklist encounters={shown.encounters.map(entry => pending?.id === entry.id && !historyId ? { ...entry, defeated: pending.defeated } : entry)} editable={!historyId && !readError} busy={Boolean(busy)} onToggle={toggle}/>
    </> : !loading && !readError && <div className="empty-panel">No practice record available.</div>}
    <section className="practice-history" aria-labelledby="practice-history-title"><div className="section-heading"><div><p className="eyebrow">ONLY YOU CAN SEE THIS</p><h2 id="practice-history-title">Practice history</h2></div><button className="button button-outline button-small" disabled={Boolean(busy) || !history.length} onClick={() => setConfirmation({ kind: 'delete-all' })}>Delete all practice history</button></div>
      {!history.length ? <div className="empty-panel">Your saved practice attempts will appear here after Died or End.</div> : <div className="player-history">{history.map(entry => <article className="history-entry" key={entry.id}><div className="history-entry-heading"><h3>{entry.outcome === 'died' ? 'Died' : 'Ended'}</h3><span>{savedDate(entry.saved_at!)}</span></div><ScoreLine {...entry}/><div className="view-actions"><PageLink to={`/practice/history/${encodeURIComponent(entry.id)}`} navigate={navigate}>View checklist →</PageLink><PageLink to={historyCompare(session.user!.username, `practice:${entry.id}`)} navigate={navigate}>Compare →</PageLink><button className="text-button danger-text" disabled={Boolean(busy)} onClick={() => setConfirmation({ kind: 'delete', id: entry.id })}>Delete</button></div></article>)}</div>}
    </section>
    {confirmation && <Modal title={confirmationTitle} onClose={() => setConfirmation(null)} busy={Boolean(busy)}><p className="modal-description">{confirmation.kind === 'reset' ? 'Clear all checkboxes in this practice draft. No history entry will be created.' : confirmation.kind === 'delete-all' ? `Permanently delete all ${history.length} saved practice attempts in your private history. Your current draft stays as it is.` : 'Permanently delete this saved practice attempt from your private history.'}</p><div className="modal-actions"><button className="button button-outline" onClick={() => setConfirmation(null)} disabled={Boolean(busy)}>Cancel</button><button className="button button-danger-solid" onClick={confirm} disabled={Boolean(busy)}>{busy ? 'Working…' : confirmation.kind === 'reset' ? 'Reset all' : confirmation.kind === 'delete-all' ? 'Delete all practice history' : 'Delete practice'}</button></div></Modal>}
  </section>
}
