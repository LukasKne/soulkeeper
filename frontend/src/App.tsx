import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { api, ApiError } from './api'
import Admin from './Admin'
import Modal from './Modal'
import Practice from './Practice'
import { Comparison, PageLink, PlayerProfile, RunDetail } from './RunPages'
import type { AttemptStatus, AttemptView, Competition, CompetitionList, Encounter, Leaderboard, Session, Username } from './types'

const anonymous: Session = { user: null, csrf_token: null }
const emptyCompetitions: CompetitionList = { competitions: [], current_id: 0 }
type Route = { id: number | null; manage: boolean; page?: 'profile' | 'detail' | 'compare' | 'practice'; username?: string; historyId?: string; key: string }
type Dialog = 'login' | 'password' | 'failed' | 'completed' | null

function readRoute(): Route {
  const path = window.location.pathname
  const key = path + window.location.search
  const match = path.match(/^\/(?:runs|competitions)\/(\d+)(?:\/players\/([a-z0-9_-]+))?\/?$/)
  if (match) return { id: Number(match[1]), manage: false, ...(match[2] ? { page: 'detail' as const, username: match[2] } : {}), key }
  const profile = path.match(/^\/players\/([a-z0-9_-]+)\/?$/)
  if (profile) return { id: null, manage: false, page: 'profile', username: profile[1], key }
  const practice = path.match(/^\/practice(?:\/history\/([a-zA-Z0-9_-]+))?\/?$/)
  if (practice) return { id: null, manage: false, page: 'practice', historyId: practice[1], key }
  return { id: null, manage: ['/admin', '/manage'].includes(path), ...(path === '/compare' ? { page: 'compare' as const } : {}), key }
}
function titleCase(value: string) { return value.charAt(0).toUpperCase() + value.slice(1) }
function isAborted(error: unknown) { return error instanceof DOMException && error.name === 'AbortError' }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.' }

function Icon({ name, size = 20 }: { name: 'flame' | 'sword' | 'shield' | 'chevron' | 'search' | 'check' | 'arrow' | 'close' | 'lock' | 'archive' | 'logout' | 'crown'; size?: number }) {
  const paths: Record<string, ReactNode> = {
    flame: <><path d="M13 2c1 6-4 6-2 11 2-1 3-3 3-5 4 3 6 6 4 10-2 5-11 5-13 0-2-4 1-7 4-10-1 5 1 6 1 6"/><path d="M12 15c-3 3-3 5 0 7 3-1 4-4 0-7Z"/></>,
    sword: <><path d="m4 20 4-4M3 15l6 6M7 13 18 2h4v4L11 17M16 4l4 4"/></>,
    shield: <><path d="m12 2 8 3v7c0 5-8 10-8 10S4 17 4 12V5l8-3Z"/><path d="M12 6v12m-4-7h8"/></>,
    chevron: <path d="m8 5 7 7-7 7"/>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    arrow: <><path d="M4 12h16m-6-6 6 6-6 6"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2"/></>,
    archive: <><path d="M4 8h16v13H4zM3 3h18v5H3zm6 9h6"/></>,
    logout: <><path d="M9 3H4v18h5m5-14 5 5-5 5m-6-5h13"/></>,
    crown: <path d="m3 6 4 4 5-7 5 7 4-4-2 13H5L3 6Zm2 17h14"/>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function Status({ value }: { value: AttemptStatus }) {
  const labels = { not_started: 'Not started', active: 'Alive', failed: 'Dead', completed: 'Alive · Completed' }
  return <span className={`life-status ${value}`}><span className="status-dot"/>{labels[value]}</span>
}

export default function App() {
  const [route, setRoute] = useState<Route>(readRoute)
  const routeRef = useRef(route); routeRef.current = route
  const [session, setSession] = useState<Session>(anonymous)
  const [competitions, setCompetitions] = useState<CompetitionList>(emptyCompetitions)
  const [board, setBoard] = useState<Leaderboard | null>(null)
  const [own, setOwn] = useState<AttemptView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [operationError, setOperationError] = useState('')
  const [notice, setNotice] = useState('')
  const [unassigned, setUnassigned] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [dialogError, setDialogError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [pendingCheck, setPendingCheck] = useState<{ id: string; defeated: boolean } | null>(null)
  const [username, setUsername] = useState<Username>('lukas')
  const [password, setPassword] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const passwordOwner = useRef<Username | null>(null)
  const [search, setSearch] = useState('')
  const [remaining, setRemaining] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const readSequence = useRef(0)
  const readController = useRef<AbortController | null>(null)
  const busyRef = useRef(false)

  const invalidateReads = useCallback(() => { readSequence.current += 1; readController.current?.abort() }, [])
  const navigate = useCallback((path: string) => {
    invalidateReads()
    window.history.pushState({}, '', path)
    setRoute(readRoute()); setBoard(null); setOwn(null); setUnassigned(false); setError(''); setOperationError(''); setLoading(true)
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [invalidateReads])

  const refresh = useCallback(async () => {
    if (busyRef.current) return
    const sequence = ++readSequence.current
    readController.current?.abort()
    const controller = new AbortController(); readController.current = controller
    const signal = controller.signal
    const scope = routeRef.current
    try {
      const [nextSession, list] = await Promise.all([api<Session>('/session', { signal }), api<CompetitionList>('/competitions', { signal })])
      const id = scope.id ?? list.current_id
      const outsideBoard = scope.manage || Boolean(scope.page)
      const [nextBoard, assignment] = await Promise.all([
        outsideBoard ? Promise.resolve(null) : api<Leaderboard>(`/competitions/${id}/leaderboard`, { signal }),
        nextSession.user && !outsideBoard ? api<AttemptView>(`/competitions/${id}/attempt`, { signal }).then(view => ({ view, unassigned: false })).catch(err => {
          if (err instanceof ApiError && err.status === 403) {
            if (sequence === readSequence.current) { setOwn(null); setUnassigned(true) }
            return { view: null, unassigned: true }
          }
          throw err
        }) : Promise.resolve({ view: null, unassigned: false }),
      ])
      if (sequence !== readSequence.current) return
      setSession(nextSession); setCompetitions(list); setBoard(nextBoard); setOwn(assignment.view); setUnassigned(assignment.unassigned); setError('')
      if (!outsideBoard && (scope.id === null || window.location.pathname.startsWith('/competitions/'))) {
        window.history.replaceState({}, '', `/runs/${id}`)
        const pinned = readRoute(); routeRef.current = pinned; setRoute(pinned)
      }
    } catch (err) {
      if (!isAborted(err) && sequence === readSequence.current) setError(errorMessage(err))
    } finally { if (sequence === readSequence.current) setLoading(false) }
  }, [])

  useEffect(() => {
    void refresh()
    const pop = () => { invalidateReads(); setRoute(readRoute()); setBoard(null); setOwn(null); setUnassigned(false); setLoading(true); setError(''); setOperationError('') }
    window.addEventListener('popstate', pop)
    return () => { window.removeEventListener('popstate', pop); invalidateReads() }
  }, [refresh, invalidateReads])

  useEffect(() => { void refresh() }, [route.key, refresh])
  useEffect(() => {
    const visibleRefresh = () => { if (document.visibilityState === 'visible') void refresh() }
    const timer = window.setInterval(visibleRefresh, 5000)
    window.addEventListener('focus', visibleRefresh); document.addEventListener('visibilitychange', visibleRefresh)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', visibleRefresh); document.removeEventListener('visibilitychange', visibleRefresh) }
  }, [refresh])

  useEffect(() => {
    if (dialog === 'password' && session.user?.username !== passwordOwner.current) {
      setDialog(null); setDialogError(''); setCurrentPassword(''); setNewPassword(''); setConfirmPassword('')
    }
  }, [dialog, session.user?.username])

  const competition = board?.competition ?? own?.competition ?? competitions.competitions.find(c => c.id === route.id)
  const archived = competition?.status === 'archived'
  const editable = Boolean(session.user && own?.attempt?.status === 'active' && !archived)
  const current = competitions.competitions.find(c => c.id === competitions.current_id)
  const maxPoints = competition?.max_points ?? 310
  const points = own?.attempt?.points ?? 0
  const encounterGroups = useMemo(() => {
    const all = new Map<string, { id: string; name: string; order: number; entries: Encounter[] }>()
    for (const encounter of own?.encounters ?? []) {
      if (!all.has(encounter.area_id)) all.set(encounter.area_id, { id: encounter.area_id, name: encounter.area_name, order: encounter.area_order, entries: [] })
      all.get(encounter.area_id)!.entries.push(encounter)
    }
    return [...all.values()].sort((a, b) => a.order - b.order)
  }, [own?.encounters])
  const filteredGroups = useMemo(() => encounterGroups.map(group => ({ ...group, visible: group.entries.filter(entry =>
    (!remaining || !entry.defeated) && (!search.trim() || `${entry.name} ${entry.area_name} ${entry.description}`.toLowerCase().includes(search.trim().toLowerCase()))
  ) })).filter(group => group.visible.length), [encounterGroups, search, remaining])

  const beginMutation = (key: string) => {
    if (busyRef.current) return false
    busyRef.current = true; setBusy(key); setNotice(''); setError(''); setOperationError(''); setDialogError(''); invalidateReads(); return true
  }
  const finishMutation = async () => { invalidateReads(); busyRef.current = false; setBusy(null); setPendingCheck(null); await refresh() }
  const closePasswordDialog = () => { setDialog(null); setDialogError(''); setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); passwordOwner.current = null }
  const openDialog = (value: Dialog) => {
    setDialogError(''); setPassword(''); setCurrentPassword(''); setNewPassword(''); setConfirmPassword('')
    passwordOwner.current = value === 'password' ? session.user?.username ?? null : null
    setDialog(value)
  }

  async function login(event: FormEvent) {
    event.preventDefault()
    if (!beginMutation('login')) return
    try { const next = await api<Session>('/login', { method: 'POST', body: { username, password } }); setSession(next); setPassword(''); setDialog(null) }
    catch (err) { setDialogError(errorMessage(err)) }
    finally { await finishMutation() }
  }
  async function logout() {
    if (!beginMutation('logout')) return
    try { await api<Session>('/logout', { method: 'POST', csrf: session.csrf_token }); setSession(anonymous); setOwn(null); if (route.manage) navigate('/') }
    catch (err) { setOperationError(errorMessage(err)) }
    finally { await finishMutation() }
  }
  async function changePassword(event: FormEvent) {
    event.preventDefault()
    if (!session.user || passwordOwner.current !== session.user.username) return
    if (newPassword !== confirmPassword) { setDialogError('New passwords do not match.'); return }
    if (!beginMutation('password')) return
    try {
      const next = await api<Session>('/account/password', { method: 'POST', csrf: session.csrf_token, body: { current_password: currentPassword, new_password: newPassword } })
      setSession(next); setOwn(null); setUnassigned(false); closePasswordDialog()
      setNotice('Password changed. Log in again with your new password.')
      if (route.manage) navigate(`/runs/${competitions.current_id}`)
    } catch (err) { setDialogError(errorMessage(err)) }
    finally { await finishMutation() }
  }
  async function startAttempt() {
    const id = competition?.id
    if (!id || !beginMutation('start')) return
    try { const next = await api<AttemptView>(`/competitions/${id}/attempt/start`, { method: 'POST', csrf: session.csrf_token }); if (routeRef.current.id === id) setOwn(next) }
    catch (err) { setOperationError(errorMessage(err)) }
    finally { await finishMutation() }
  }
  async function toggle(encounter: Encounter) {
    const id = competition?.id
    if (!id || !editable || !beginMutation(encounter.id)) return
    setPendingCheck({ id: encounter.id, defeated: !encounter.defeated })
    try {
      const next = await api<AttemptView>(`/competitions/${id}/attempt/encounters/${encodeURIComponent(encounter.id)}`, { method: 'PUT', body: { defeated: !encounter.defeated }, csrf: session.csrf_token })
      if (routeRef.current.id === id) setOwn(next)
    } catch (err) { setOperationError(errorMessage(err)) }
    finally { await finishMutation() }
  }
  async function confirm() {
    const action = dialog
    const id = competition?.id
    if ((action !== 'failed' && action !== 'completed') || !beginMutation(action)) return
    try {
      if (id) {
        const next = await api<AttemptView>(`/competitions/${id}/attempt/finish`, { method: 'POST', body: { outcome: action }, csrf: session.csrf_token })
        if (routeRef.current.id === id) setOwn(next)
        setDialog(null)
      }
    } catch (err) { setDialogError(errorMessage(err)) }
    finally { await finishMutation() }
  }

  return <>
    <header className="site-header">
      <div className="header-inner">
        <a href="/" className="brand" onClick={event => { event.preventDefault(); navigate('/') }}><span className="brand-mark"><Icon name="flame" size={27}/></span><span>SOULKEEPER<span className="brand-sub">DARK SOULS REMASTERED</span></span></a>
        <nav aria-label="Main navigation">
          <a href={route.manage || route.page ? '/' : '#leaderboard'} className={!route.manage && !route.page ? 'nav-link active' : 'nav-link'} onClick={event => { if (route.manage || route.page) { event.preventDefault(); navigate('/') } }}>Leaderboard</a>
          <PageLink to={`/compare?run=${route.id ?? competitions.current_id}`} navigate={navigate} className={`nav-link ${route.page === 'compare' ? 'active' : ''}`}>Compare</PageLink>
          {session.user && <PageLink to="/practice" navigate={navigate} className={`nav-link ${route.page === 'practice' ? 'active' : ''}`}>Practice</PageLink>}
          {session.user?.can_manage && <a href="/admin" className={route.manage ? 'nav-link active' : 'nav-link'} onClick={event => { event.preventDefault(); navigate('/admin') }}>Admin</a>}
        </nav>
        {session.user ? <div className="account"><PageLink to={`/players/${session.user.username}`} navigate={navigate} className="account-avatar" ariaLabel="My run history">{session.user.username[0].toUpperCase()}</PageLink><PageLink to={`/players/${session.user.username}`} navigate={navigate} className="account-name">{titleCase(session.user.username)}</PageLink><button className="account-password" onClick={() => openDialog('password')} aria-label="Change password" title="Change password" disabled={Boolean(busy)}><Icon name="lock" size={15}/><span>Change password</span></button><button className="icon-button" onClick={() => void logout()} aria-label="Log out" disabled={Boolean(busy)}><Icon name="logout" size={18}/></button></div> : <button className="button button-small button-outline" onClick={() => openDialog('login')}><Icon name="lock" size={14}/>Player login</button>}
      </div>
    </header>

    <main className="shell">
      <section className="hero">
        <div className="hero-copy"><p className="eyebrow"><span className="gold-line"/>THE NO-DEATH CHRONICLES</p><h1>{route.manage || (route.page && route.page !== 'practice') ? <>Every run deserves<br/><em>to be remembered.</em></> : route.page === 'practice' ? <>Practice.<br/><em>Keep learning.</em></> : <>One life.<br/><em>Make it count.</em></>}</h1><p className="hero-description">A shared challenge. One unforgiving world.<br className="desktop-break"/> Every victory recorded. Every fallen run remembered.</p></div>
        <div className="hero-art" aria-hidden="true"><div className="art-ring art-ring-one"/><div className="art-ring art-ring-two"/><div className="art-ring art-ring-three"/><svg viewBox="0 0 280 280" className="bonfire"><defs><linearGradient id="ember" x1="0" y1="1" x2="1" y2="0"><stop stopColor="#6a4a26"/><stop offset=".55" stopColor="#d0b27b"/><stop offset="1" stopColor="#f2dbac"/></linearGradient></defs><g fill="none" stroke="url(#ember)" strokeLinecap="round" strokeLinejoin="round"><path className="bonfire-glow" d="M143 42v156m-9-142 9-14 9 14m-22 68 27-5m-14 5-2 73m-31-3 66 32m-63 0 66-32m-75 22 78 25m-74 0 73-25" strokeWidth="3"/><path d="M132 194c-25-20-31-41-16-68-2 21 4 27 12 32-8-32 17-40 21-61 15 27 3 42 13 59 5-6 8-14 7-24 28 37 15 62-10 71" strokeWidth="1.4" opacity=".65"/></g><g fill="#c5a466"><circle cx="101" cy="103" r="1.5"/><circle cx="171" cy="82" r="2"/><circle cx="184" cy="130" r="1.3"/><circle cx="117" cy="73" r="1"/><circle cx="158" cy="51" r="1.5"/></g></svg><span className="art-caption">DON’T YOU DARE GO HOLLOW.</span></div>
      </section>

      {(error || operationError) && <div className="error-banner" role="alert"><span>{operationError || error}</span><button onClick={() => { if (operationError) setOperationError(''); else void refresh() }} className="text-button">{operationError ? 'Dismiss' : 'Retry'}</button></div>}

      {notice && <div className="success-banner" role="status">{notice}</div>}
      {route.manage ? <Admin session={session} competitions={competitions} navigate={navigate} onLogin={() => openDialog('login')} onSessionInvalidated={text => {
        invalidateReads(); setSession(anonymous); setOwn(null); setUnassigned(false); setNotice(text); void refresh()
      }}/> : route.page === 'profile' ? <PlayerProfile key={route.key} username={route.username!} session={session} navigate={navigate}/> : route.page === 'detail' ? <RunDetail key={route.key} id={route.id!} username={route.username!} session={session} navigate={navigate}/> : route.page === 'compare' ? (competitions.current_id ? <Comparison key={`${route.key}:${session.user?.username ?? 'anonymous'}`} session={session} competitions={competitions} navigate={navigate} onLogin={() => openDialog('login')} search={window.location.search}/> : <p role="status">Opening comparison…</p>) : route.page === 'practice' ? <Practice key={`${session.user?.username ?? 'anonymous'}:${route.historyId ?? ''}`} session={session} historyId={route.historyId} navigate={navigate} onLogin={() => openDialog('login')}/> : <>
        <section className="competition-toolbar" aria-label="Run selection"><div className="chapter-label"><span className="chapter-number">{String(competition?.number ?? 1).padStart(2, '0')}</span><div><span className="eyebrow">{archived ? 'FROM THE ARCHIVES' : 'THE CURRENT CHAPTER'}</span><h2>{competition?.name ?? 'The ledger'}</h2></div></div><div className="competition-picker"><label htmlFor="competition-select">Browse runs</label><div className="select-wrap"><select id="competition-select" value={competition?.id ?? ''} disabled={!competitions.competitions.length} onChange={event => navigate(`/runs/${event.target.value}`)}>{!competitions.competitions.length && <option value="">Loading competitions…</option>}{competitions.competitions.map(item => <option key={item.id} value={item.id}>{item.name} · {item.status === 'current' ? 'Current' : 'Archived'}</option>)}</select><Icon name="chevron" size={16}/></div></div></section>

        {archived && <div className="archive-banner"><Icon name="archive" size={21}/><div><strong>This chapter is preserved.</strong><span>Scores and life statuses are final. This run and your checklist are read-only.</span></div>{current && <button className="text-button" onClick={() => navigate(`/runs/${current.id}`)}>View current run<Icon name="arrow" size={15}/></button>}</div>}

        <section className="leaderboard-section" id="leaderboard" aria-labelledby="leaderboard-title"><div className="section-heading"><div><p className="eyebrow">THE STANDINGS</p><h2 id="leaderboard-title">The challengers</h2></div><PageLink to={`/compare?run=${competition?.id ?? competitions.current_id}`} navigate={navigate}>Compare players →</PageLink><span className="live-label"><span className={archived ? 'quiet-dot' : 'live-dot'}/>{archived ? 'Archived leaderboard' : 'Live · updates every 5s'}</span></div>
          {loading && !board ? <div className="loading-panel" role="status">Opening the ledger…</div> : board ? <div className="challengers">{board.players.map(player => <article className={`challenger-card ${player.attempt_status} ${session.user?.username === player.username ? 'is-you' : ''}`} key={player.username}><div className="challenger-top"><span className="challenger-rank">{player.attempt_status === 'not_started' ? '—' : String(player.rank).padStart(2, '0')}<span>RANK</span></span><Status value={player.attempt_status}/></div><div className="challenger-identity"><div className="player-emblem"><span>{player.username[0].toUpperCase()}</span><Icon name="shield" size={28}/></div><div><span className="eyebrow">CHOSEN UNDEAD{session.user?.username === player.username ? ' · YOU' : ''}</span><h3><PageLink to={`/players/${encodeURIComponent(player.username)}`} navigate={navigate} className="player-name-link">{titleCase(player.username)}</PageLink></h3></div></div><div className="player-score"><strong>{player.points}</strong><span>/ {maxPoints}<br/>POINTS</span><span className="score-ornament">✦</span></div><div className="score-track" role="progressbar" aria-label={`${titleCase(player.username)} score`} aria-valuemin={0} aria-valuemax={maxPoints} aria-valuenow={player.points}><span style={{ width: `${Math.min(100, player.points / maxPoints * 100)}%` }}/></div><div className="player-breakdown"><span><Icon name="crown" size={16}/><strong>{player.bosses_defeated}</strong> bosses</span><span><Icon name="sword" size={16}/><strong>{player.minibosses_defeated}</strong> minibosses</span></div></article>)}</div> : !error && <div className="loading-panel">No leaderboard available.</div>}
          <div className="scoring-note"><span><span className="point-lozenge">5</span>per boss encounter</span><span><span className="point-lozenge mini">3</span>per miniboss</span><span className="scoring-total">26 bosses · 60 minibosses · one life per run</span></div>
        </section>

        {session.user && unassigned && <section className="empty-panel unassigned-panel" id="my-run"><h2>You are not assigned to this run.</h2><p>You can still follow the public leaderboard. Ask Lukas to add you to a current run.</p></section>}
        {session.user && own ? <section className="run-section" id="my-run" aria-labelledby="run-title"><div className="section-heading"><div><p className="eyebrow">YOUR JOURNEY</p><h2 id="run-title">{titleCase(session.user.username)}’s field ledger</h2></div><span className="run-tag">{competition?.name}</span></div>
          <div className="personal-summary"><div className="personal-points"><Icon name="flame" size={25}/><strong>{points}</strong><span>POINTS</span><span className="summary-divider"/><Status value={own.attempt?.status ?? 'not_started'}/></div><div className="run-actions">{archived ? <span className="read-only-label"><Icon name="lock" size={15}/>Archived · Read-only</span> : !own.attempt ? <button className="button button-gold" onClick={() => void startAttempt()} disabled={Boolean(busy)}>{busy === 'start' ? 'Starting…' : 'Start my attempt'}<Icon name="arrow" size={17}/></button> : editable ? <><span className="save-state" role="status">{busy && pendingCheck ? 'Saving…' : 'Progress saved automatically'}</span><button className="button button-outline button-small" onClick={() => openDialog('completed')} disabled={Boolean(busy)}>Finish run</button><button className="button button-danger button-small" onClick={() => openDialog('failed')} disabled={Boolean(busy)}>I died</button></> : <span className="read-only-label"><Icon name="lock" size={15}/>Attempt ended · Read-only</span>}</div></div>
          {!own.attempt && !archived && <p className="attempt-intro">Your one attempt is waiting. Start when you enter Lordran; then mark each encounter as you defeat it.</p>}
          {own.attempt?.status === 'failed' && <p className="ended-note">Your journey ends here. Your victories remain in the ledger.</p>}
          <div className="ledger-filters"><div className="search-wrap"><Icon name="search" size={18}/><input type="search" aria-label="Search encounters or locations" placeholder="Search encounters or locations…" value={search} onChange={event => setSearch(event.target.value)}/>{search && <button className="icon-button" aria-label="Clear search" onClick={() => setSearch('')}><Icon name="close" size={15}/></button>}</div><label className="remaining-toggle"><input type="checkbox" checked={remaining} onChange={event => setRemaining(event.target.checked)}/><span className="toggle-switch"/>Remaining only</label><button className="text-button collapse-button" onClick={() => setCollapsed(collapsed.size === encounterGroups.length ? new Set() : new Set(encounterGroups.map(group => group.id)))}>{collapsed.size === encounterGroups.length ? 'Expand all' : 'Collapse all'}</button></div>
          <div className="area-list">{filteredGroups.length ? filteredGroups.map(group => { const expanded = !collapsed.has(group.id) || Boolean(search.trim()); const defeated = group.entries.filter(entry => entry.defeated).length; return <section className={`area ${defeated === group.entries.length ? 'area-complete' : ''}`} key={group.id}><button className="area-heading" aria-expanded={expanded} aria-controls={`area-${group.id}`} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next })}><span className="area-index">{String(group.order).padStart(2, '0')}</span><h3>{group.name}</h3><span className="area-progress">{defeated}<span> / {group.entries.length}</span></span><span className={expanded ? 'area-chevron expanded' : 'area-chevron'}><Icon name="chevron" size={17}/></span></button>{expanded && <div id={`area-${group.id}`} className="area-encounters">{group.visible.map(entry => { const checked = pendingCheck?.id === entry.id ? pendingCheck.defeated : entry.defeated; return <label className={`encounter ${checked ? 'defeated' : ''} ${!editable ? 'locked' : ''}`} key={entry.id}><input type="checkbox" checked={checked} disabled={!editable || Boolean(busy)} onChange={() => void toggle(entry)}/><span className="encounter-checkbox">{busy === entry.id ? <span className="small-spinner"/> : checked ? <Icon name="check" size={14}/> : null}</span><span className="encounter-copy"><strong>{entry.name}</strong><span>{entry.description}</span></span><span className={`encounter-kind ${entry.kind}`}>{entry.kind === 'boss' ? 'Boss' : 'Miniboss'}</span><span className="encounter-points">+{entry.points}</span></label> })}</div>}</section> }) : <div className="empty-panel filter-empty"><Icon name="search" size={25}/><h3>No encounters found.</h3><p>Try another search or turn off “Remaining only”.</p></div>}</div>
        </section> : !session.user && !loading ? <section className="join-panel"><span className="join-emblem"><Icon name="flame" size={30}/></span><div><h2>Your journey awaits.</h2><p>Log in to mark your victories and keep your own field ledger.</p></div><button className="button button-gold" onClick={() => openDialog('login')}>Enter the ledger<Icon name="arrow" size={17}/></button></section> : null}
      </>}

      <footer className="site-footer"><a className="footer-brand" href="/" onClick={event => { event.preventDefault(); navigate('/') }}><Icon name="flame" size={18}/>SOULKEEPER</a><span>A ledger for the chosen undead.</span><span>Vanilla + Artorias of the Abyss</span></footer>
    </main>

    {dialog === 'login' && <Modal title="Enter the ledger" onClose={() => setDialog(null)} busy={Boolean(busy)}><p className="modal-description">Your victories, your one chance.<br/>Log in to your player account to continue.</p><form onSubmit={event => void login(event)}><label className="form-label" htmlFor="player-name">Username</label><input className="form-input" id="player-name" value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required disabled={Boolean(busy)}/><label className="form-label" htmlFor="player-password">Password</label><input className="form-input" id="player-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required disabled={Boolean(busy)}/>{dialogError && <p role="alert" className="form-error">{dialogError}</p>}<button className="button button-gold modal-submit" type="submit" disabled={Boolean(busy) || !password}>{busy === 'login' ? 'Entering…' : 'Enter the ledger'}<Icon name="arrow" size={17}/></button></form></Modal>}
    {dialog === 'password' && session.user && <Modal title="Change password" onClose={closePasswordDialog} busy={Boolean(busy)}><p className="modal-description">Choose a password with at least 12 characters. You’ll be signed out on all devices after changing it.</p><form onSubmit={event => void changePassword(event)}><label className="form-label" htmlFor="account-current-password">Current password</label><input className="form-input" id="account-current-password" type="password" autoComplete="current-password" maxLength={1024} required value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} disabled={Boolean(busy)}/><label className="form-label" htmlFor="account-new-password">New password</label><input className="form-input" id="account-new-password" type="password" autoComplete="new-password" minLength={12} maxLength={1024} required value={newPassword} onChange={event => setNewPassword(event.target.value)} disabled={Boolean(busy)}/><label className="form-label" htmlFor="account-confirm-password">Confirm new password</label><input className="form-input" id="account-confirm-password" type="password" autoComplete="new-password" minLength={12} maxLength={1024} required value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} disabled={Boolean(busy)}/>{dialogError && <p className="form-error" role="alert">{dialogError}</p>}<button className="button button-gold modal-submit" type="submit" disabled={Boolean(busy) || !currentPassword || newPassword.length < 12 || !confirmPassword}>{busy === 'password' ? 'Changing…' : 'Change password'}</button></form></Modal>}
    {(dialog === 'failed' || dialog === 'completed') && <Modal title={dialog === 'failed' ? 'Has your journey ended?' : 'Complete your journey?'} onClose={() => setDialog(null)} busy={Boolean(busy)}><p className="modal-description">{dialog === 'failed' ? `This marks you as Dead with ${points} points. Your checklist will be permanently locked for this run. Your recorded victories will be preserved.` : `This saves your final score of ${points} points and marks your attempt completed. You remain Alive, and your checklist will be permanently locked for this run.`}</p>{dialogError && <p role="alert" className="form-error">{dialogError}</p>}<div className="modal-actions"><button className="button button-outline" onClick={() => setDialog(null)} disabled={Boolean(busy)}>Cancel</button><button className={`button ${dialog === 'failed' ? 'button-danger-solid' : 'button-gold'}`} onClick={() => void confirm()} disabled={Boolean(busy) || !editable}>{busy ? 'Saving…' : dialog === 'failed' ? 'Confirm death' : 'Complete run'}</button></div></Modal>}
  </>
}
