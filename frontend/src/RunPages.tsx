import { useCallback, useMemo, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { api } from './api'
import Checklist from './Checklist'
import { usePolling } from './usePolling'
import type { CompetitionList, Encounter, PlayerRuns, PracticeSummary, PracticeView, RunProgress, Session } from './types'

export const displayName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1)
export const savedDate = (date: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date))
export const statusLabel = (status: string) => ({ not_started: 'Not started', active: 'Alive', failed: 'Dead', completed: 'Alive · Completed', died: 'Practice · Died', ended: 'Practice · Ended' })[status] ?? status
export const historyCompare = (username: string, left?: string) => `/compare?${new URLSearchParams({ mode: 'history', player: username, ...(left ? { left } : {}) })}`

export function PageLink({ to, navigate, children, className = 'text-button', ariaLabel }: { to: string; navigate: (path: string) => void; children: ReactNode; className?: string; ariaLabel?: string }) {
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    event.preventDefault(); navigate(to)
  }
  return <a href={to} onClick={click} className={className} aria-label={ariaLabel}>{children}</a>
}

function LoadState({ error, retry }: { error: string; retry: () => void }) {
  return error ? <div className="error-banner" role="alert">{error}<button className="text-button" onClick={retry}>Retry</button></div> : <p role="status">Opening the ledger…</p>
}

export function ScoreLine({ points, max_points, bosses_defeated, minibosses_defeated }: { points: number; max_points: number; bosses_defeated: number; minibosses_defeated: number }) {
  return <div className="view-score"><strong>{points}<small> / {max_points} points</small></strong><span>{bosses_defeated} bosses · {minibosses_defeated} minibosses</span></div>
}

export function PlayerProfile({ username, session, navigate }: { username: string; session: Session; navigate: (path: string) => void }) {
  const load = useCallback((signal: AbortSignal) => api<PlayerRuns>(`/players/${encodeURIComponent(username)}/runs`, { signal }), [username])
  const { data, error, refresh } = usePolling(load)
  return <section className="run-page" aria-labelledby="profile-title">
    <div className="section-heading"><div><p className="eyebrow">PLAYER HISTORY</p><h2 id="profile-title">{displayName(username)}’s runs</h2></div><PageLink to={historyCompare(username)} navigate={navigate}>Compare across runs →</PageLink></div>
    <p className="section-description">Official attempts and checklists are public, including archived runs.</p>
    {!data ? <LoadState error={error} retry={() => void refresh()}/> : <div className="player-history">{data.runs.map(run => <article className="history-entry" key={run.competition.id}>
      <div className="history-entry-heading"><h3>{run.competition.name}</h3><span className={`chapter-badge ${run.competition.status}`}>{run.competition.status === 'current' ? 'Current' : 'Archived'}</span></div>
      <p>{statusLabel(run.attempt_status)}</p><ScoreLine {...run} max_points={run.competition.max_points}/>
      <div className="view-actions"><PageLink to={`/runs/${run.competition.id}/players/${encodeURIComponent(username)}`} navigate={navigate}>View checklist →</PageLink><PageLink to={historyCompare(username, `run:${run.competition.id}`)} navigate={navigate}>Compare →</PageLink></div>
    </article>)}{!data.runs.length && <div className="empty-panel">No official runs assigned yet.</div>}</div>}
    {session.user?.username === username && <div className="practice-note"><strong>Your practice stays private.</strong><PageLink to="/practice" navigate={navigate}>Open practice and saved history →</PageLink></div>}
  </section>
}

export function RunDetail({ id, username, session, navigate }: { id: number; username: string; session: Session; navigate: (path: string) => void }) {
  const load = useCallback((signal: AbortSignal) => api<RunProgress>(`/competitions/${id}/progress`, { signal }), [id])
  const { data, error, refresh } = usePolling(load)
  const player = data?.players.find(entry => entry.username === username)
  const encounters = data && player ? data.encounters.map(entry => ({ ...entry, defeated: player.defeated_ids.includes(entry.id) })) : []
  return <section className="run-page" aria-labelledby="detail-title">
    <div className="section-heading"><div><p className="eyebrow">PUBLIC CHECKLIST</p><h2 id="detail-title">{displayName(username)} · {data?.competition.name ?? 'Run'}</h2></div><PageLink to={`/players/${encodeURIComponent(username)}`} navigate={navigate}>Player history →</PageLink></div>
    {!data ? <LoadState error={error} retry={() => void refresh()}/> : !player ? <div className="empty-panel">This player is not assigned to this run.</div> : <>
      <div className="public-summary"><ScoreLine {...player} max_points={data.competition.max_points}/><span>{statusLabel(player.attempt_status)} · {data.competition.status === 'archived' ? 'Archived' : 'Current'} · Read-only</span></div>
      <div className="view-actions"><PageLink to={`/runs/${id}`} navigate={navigate}>View leaderboard →</PageLink><PageLink to={`/compare?run=${id}&left=${encodeURIComponent(username)}`} navigate={navigate}>Compare players →</PageLink>{session.user?.username === username && <PageLink to={`/runs/${id}`} navigate={navigate}>Open my tracker →</PageLink>}</div>
      <Checklist encounters={encounters}/>
    </>}
  </section>
}

type Comparable = { title: string; username: string; status: string; points: number; max_points: number; bosses_defeated: number; minibosses_defeated: number; encounters: Encounter[] }
type Option = { value: string; label: string }
type ComparisonData = { progress: RunProgress; player: string; options: Option[]; leftKey: string; rightKey: string; left: Comparable | null; right: Comparable | null }
function fromOfficial(progress: RunProgress, username: string): Comparable {
  const player = progress.players.find(entry => entry.username === username)
  if (!player) throw new Error('This player is not assigned to the selected run.')
  return { ...player, title: progress.competition.name, status: player.attempt_status, max_points: progress.competition.max_points, encounters: progress.encounters.map(entry => ({ ...entry, defeated: player.defeated_ids.includes(entry.id) })) }
}
function fromPractice(record: PracticeView): Comparable {
  return { ...record, title: `Practice · ${savedDate(record.saved_at!)}`, status: record.outcome ?? 'ended' }
}

export function Comparison({ session, competitions, navigate, onLogin, search }: { session: Session; competitions: CompetitionList; navigate: (path: string) => void; onLogin: () => void; search: string }) {
  const params = new URLSearchParams(search)
  const history = params.get('mode') === 'history'
  const id = Number(params.get('run')) || competitions.current_id
  const playerParam = params.get('player') ?? session.user?.username ?? ''
  const [filter, setFilter] = useState('')
  const [differences, setDifferences] = useState(false)
  const load = useCallback(async (signal: AbortSignal): Promise<ComparisonData> => {
    const progress = await api<RunProgress>(`/competitions/${id}/progress`, { signal })
    const player = playerParam || progress.players[0]?.username || ''
    if (!history) {
      const leftKey = new URLSearchParams(search).get('left') ?? progress.players[0]?.username ?? ''
      const rightKey = new URLSearchParams(search).get('right') ?? progress.players.find(entry => entry.username !== leftKey)?.username ?? ''
      return { progress, player, options: progress.players.map(entry => ({ value: entry.username, label: displayName(entry.username) })), leftKey, rightKey, left: leftKey ? fromOfficial(progress, leftKey) : null, right: rightKey ? fromOfficial(progress, rightKey) : null }
    }
    const [runs, saved] = await Promise.all([
      api<PlayerRuns>(`/players/${encodeURIComponent(player)}/runs`, { signal }),
      session.user?.username === player ? api<{ attempts: PracticeSummary[] }>('/practice/history', { signal }) : Promise.resolve({ attempts: [] }),
    ])
    const options = [...runs.runs.map(run => ({ value: `run:${run.competition.id}`, label: `${run.competition.name} · ${statusLabel(run.attempt_status)} · ${run.points} points` })), ...saved.attempts.map(record => ({ value: `practice:${record.id}`, label: `Practice · ${savedDate(record.saved_at!)} · ${record.outcome === 'died' ? 'Died' : 'Ended'} · ${record.points} points` }))]
    const leftKey = new URLSearchParams(search).get('left') ?? options[0]?.value ?? ''
    const rightKey = new URLSearchParams(search).get('right') ?? options.find(option => option.value !== leftKey)?.value ?? ''
    async function resolve(key: string): Promise<Comparable | null> {
      if (!key) return null
      if (!options.some(option => option.value === key)) {
        if (key.startsWith('practice:') && session.user?.username !== player) throw new Error('Private practice comparisons are only available to their owner. Sign in to your account to view them.')
        throw new Error('This saved attempt is no longer available. Choose another comparison.')
      }
      if (key.startsWith('practice:')) return fromPractice(await api<PracticeView>(`/practice/history/${encodeURIComponent(key.slice(9))}`, { signal }))
      const runId = Number(key.slice(4))
      return fromOfficial(runId === id ? progress : await api<RunProgress>(`/competitions/${runId}/progress`, { signal }), player)
    }
    const [left, right] = await Promise.all([resolve(leftKey), resolve(rightKey)])
    return { progress, player, options, leftKey, rightKey, left, right }
  }, [id, history, playerParam, search, session.user?.username])
  const { data, error, refresh } = usePolling(load)
  function select(key: string, value: string) {
    const next = new URLSearchParams(search)
    next.set(key, value)
    if (key === 'run' || key === 'player') { next.delete('left'); next.delete('right') }
    navigate(`/compare?${next}`)
  }
  const rows = useMemo(() => {
    const all = new Map<string, { entry: Encounter; left?: Encounter; right?: Encounter }>()
    for (const entry of data?.left?.encounters ?? []) all.set(entry.id, { entry, left: entry })
    for (const entry of data?.right?.encounters ?? []) { const row = all.get(entry.id) ?? { entry }; all.set(entry.id, { ...row, right: entry }) }
    const needle = filter.trim().toLowerCase()
    return [...all.values()].filter(row => (!differences || !row.left || !row.right || row.left.defeated !== row.right.defeated || row.left.points !== row.right.points) && (!needle || `${row.entry.name} ${row.entry.area_name} ${row.left?.description ?? ''} ${row.right?.name ?? ''} ${row.right?.area_name ?? ''}`.toLowerCase().includes(needle))).sort((a, b) => a.entry.area_order - b.entry.area_order)
  }, [data, filter, differences])
  const groups = useMemo(() => {
    const areas = new Map<string, { name: string; rows: typeof rows }>()
    for (const row of rows) { if (!areas.has(row.entry.area_id)) areas.set(row.entry.area_id, { name: row.entry.area_name, rows: [] }); areas.get(row.entry.area_id)!.rows.push(row) }
    return [...areas.entries()]
  }, [rows])
  const names = [...new Set([...(data?.progress.players.map(player => player.username) ?? []), data?.player ?? playerParam, session.user?.username ?? ''].filter(Boolean))]
  return <section className="run-page" aria-labelledby="compare-title">
    <div className="section-heading"><div><p className="eyebrow">SIDE BY SIDE</p><h2 id="compare-title">Direct comparison</h2></div></div>
    <div className="admin-tabs" role="tablist" aria-label="Comparison modes"><button role="tab" aria-selected={!history} onClick={() => navigate(`/compare?run=${id}`)}>Players</button><button role="tab" aria-selected={history} onClick={() => navigate(historyCompare(session.user?.username ?? data?.player ?? playerParam))}>Across runs</button></div>
    {!data ? <><LoadState error={error} retry={() => void refresh()}/>{error && <div className="view-actions"><PageLink to={history ? historyCompare(playerParam) : `/compare?run=${id}`} navigate={navigate}>Reset comparison →</PageLink>{!session.user && <button className="text-button" onClick={onLogin}>Player login</button>}</div>}</> : <>
      <div className="comparison-selectors">
        {history ? <label>Player<select aria-label="Comparison player" value={data.player} onChange={event => select('player', event.target.value)}>{names.map(name => <option key={name} value={name}>{displayName(name)}</option>)}</select></label> : <label>Run<select aria-label="Comparison run" value={id} onChange={event => select('run', event.target.value)}>{competitions.competitions.map(run => <option key={run.id} value={run.id}>{run.name}</option>)}</select></label>}
        <label>{history ? 'First attempt' : 'First player'}<select aria-label={history ? 'First attempt' : 'First player'} value={data.leftKey} onChange={event => select('left', event.target.value)}>{data.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label>{history ? 'Second attempt' : 'Second player'}<select aria-label={history ? 'Second attempt' : 'Second player'} value={data.rightKey} onChange={event => select('right', event.target.value)}><option value="">Choose another…</option>{data.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      </div>
      {history && session.user?.username === data.player && <p className="practice-note">Saved practice attempts are visible only to you. <PageLink to="/practice" navigate={navigate}>Open practice →</PageLink></p>}
      {!data.left || !data.right || data.leftKey === data.rightKey ? <div className="empty-panel">Choose two different {history ? 'attempts' : 'players'} to compare.{data.options.length < 2 && <p>{history ? 'Save another practice attempt or join another official run to add a comparison.' : 'This run has fewer than two participants.'}</p>}</div> : <>
        <div className="comparison-cards">{[data.left, data.right].map((attempt, index) => <article className="history-entry" key={index}><h3>{history ? attempt.title : displayName(attempt.username)}</h3><p>{statusLabel(attempt.status)}</p><ScoreLine {...attempt}/>{!history && <PageLink to={`/runs/${id}/players/${encodeURIComponent(attempt.username)}`} navigate={navigate}>Full checklist →</PageLink>}</article>)}</div>
        <p className="comparison-gap" role="status">{data.left.points === data.right.points ? 'Level on points' : `${history ? (data.left.points > data.right.points ? data.left.title : data.right.title) : displayName(data.left.points > data.right.points ? data.left.username : data.right.username)} leads by ${Math.abs(data.left.points - data.right.points)} points`}</p>
        <div className="ledger-filters"><div className="search-wrap"><input type="search" aria-label="Search comparison" placeholder="Search encounters or locations…" value={filter} onChange={event => setFilter(event.target.value)}/></div><label className="remaining-toggle"><input type="checkbox" checked={differences} onChange={event => setDifferences(event.target.checked)}/><span className="toggle-switch"/>Differences only</label></div>
        <div className="comparison-table" role="table" aria-label="Encounter comparison"><div className="comparison-row comparison-head" role="row"><span role="columnheader">Encounter</span><span role="columnheader">{history ? data.left.title : displayName(data.left.username)}</span><span role="columnheader">{history ? data.right.title : displayName(data.right.username)}</span></div>{groups.map(([areaId, group]) => <div role="rowgroup" key={areaId}><h3 className="comparison-area">{group.name}</h3>{group.rows.map(row => <div className="comparison-row" role="row" key={row.entry.id}><span role="cell"><strong>{row.entry.name}</strong><small>{row.entry.kind === 'boss' ? 'Boss' : 'Miniboss'}</small></span>{[row.left, row.right].map((entry, index) => <span role="cell" key={index} className={entry?.defeated ? 'comparison-killed' : 'comparison-remaining'}>{!entry ? 'Not in this run' : <><span aria-hidden="true">{entry.defeated ? '✓' : '—'}</span> {entry.defeated ? 'Defeated' : 'Remaining'}<small>+{entry.points}</small></>}</span>)}</div>)}</div>)}{!rows.length && <p className="empty-panel">No encounters match these filters.</p>}</div>
      </>}
    </>}
  </section>
}
