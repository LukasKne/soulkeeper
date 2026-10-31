import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { api } from './api'
import Modal from './Modal'
import type { AdminUser, Competition, CompetitionList, Session } from './types'

type Props = {
  session: Session
  competitions: CompetitionList
  navigate: (path: string) => void
  onLogin: () => void
  onSessionInvalidated: (message: string) => void
}
type Assignment = { competitionId: number; original: string[]; selected: string[] }
type PendingCompetition = { expected_current_id: number; participants: string[]; name?: string; previousName: string }
const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.'
const displayName = (username: string) => username.charAt(0).toUpperCase() + username.slice(1)

function ParticipantPicker({ users, selected, onChange, disabled, existing = [], label }: { users: AdminUser[]; selected: string[]; onChange: (value: string[]) => void; disabled: boolean; existing?: string[]; label: string }) {
  return <fieldset className="participant-picker" disabled={disabled}><legend>{label}</legend>{users.map(user => {
    const eligible = user.active || existing.includes(user.username)
    return <label className={`participant-option ${!eligible ? 'unavailable' : ''}`} key={user.username}><input type="checkbox" checked={selected.includes(user.username)} disabled={!eligible} onChange={event => onChange(event.target.checked ? [...selected, user.username] : selected.filter(name => name !== user.username))}/><span>{displayName(user.username)}</span>{!user.active && <small>Disabled{existing.includes(user.username) ? ' · already assigned' : ''}</small>}</label>
  })}</fieldset>
}

export default function Admin({ session, competitions, navigate, onLogin, onSessionInvalidated }: Props) {
  const [tab, setTab] = useState<'competitions' | 'users'>('competitions')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [assignment, setAssignment] = useState<Assignment | null>(null)
  const [newParticipants, setNewParticipants] = useState<string[] | null>(null)
  const [competitionName, setCompetitionName] = useState('')
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [resetUser, setResetUser] = useState<string | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [pendingCompetition, setPendingCompetition] = useState<PendingCompetition | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [dialogError, setDialogError] = useState('')
  const [success, setSuccess] = useState('')
  const sequence = useRef(0)
  const current = competitions.competitions.find(item => item.id === competitions.current_id)
  const currentId = current?.id
  const canManage = Boolean(session.user?.can_manage)
  const assignmentReady = Boolean(currentId && assignment?.competitionId === currentId)

  useEffect(() => {
    if (!canManage || !currentId) { setLoading(false); return }
    const version = ++sequence.current
    const controller = new AbortController()
    setLoading(true); setError('')
    Promise.all([
      api<{ users: AdminUser[] }>('/admin/users', { signal: controller.signal }),
      api<{ participants: string[] }>(`/admin/competitions/${currentId}/participants`, { signal: controller.signal }),
    ]).then(([accounts, members]) => {
      if (version !== sequence.current) return
      setUsers(accounts.users)
      setNewParticipants(previous => previous ?? accounts.users.filter(user => user.active).map(user => user.username))
      setAssignment({ competitionId: currentId, original: members.participants, selected: members.participants })
    }).catch(err => { if (version === sequence.current && !(err instanceof DOMException && err.name === 'AbortError')) setError(message(err)) })
      .finally(() => { if (version === sequence.current) setLoading(false) })
    return () => { sequence.current += 1; controller.abort() }
  }, [canManage, currentId])

  function begin(action: string) {
    if (busy) return false
    setBusy(action); setError(''); setDialogError(''); setSuccess(''); return true
  }
  function updatedUsers(user: AdminUser) {
    const next = users.some(item => item.username === user.username) ? users.map(item => item.username === user.username ? user : item) : [...users, user]
    setUsers(next)
    setNewParticipants(selected => (selected ?? []).filter(name => next.some(item => item.username === name && item.active)))
  }
  async function createUser(event: FormEvent) {
    event.preventDefault()
    if (loading || !begin('create-user')) return
    try {
      const result = await api<{ user: AdminUser }>('/admin/users', { method: 'POST', csrf: session.csrf_token, body: { username: newUsername.trim(), password: newPassword } })
      updatedUsers(result.user); setNewUsername(''); setNewPassword(''); setSuccess(`${displayName(result.user.username)} was created. Assign them to a run to let them play.`)
    } catch (err) { setError(message(err)) }
    finally { setBusy(null) }
  }
  async function setActive(user: AdminUser) {
    if (!begin(user.username)) return
    try {
      const result = await api<{ user: AdminUser }>(`/admin/users/${encodeURIComponent(user.username)}`, { method: 'PATCH', csrf: session.csrf_token, body: { active: !user.active } })
      updatedUsers(result.user); setSuccess(`${displayName(user.username)} is ${result.user.active ? 'enabled' : 'disabled'}. Existing run records are preserved.`)
    } catch (err) { setError(message(err)) }
    finally { setBusy(null) }
  }
  async function changePassword(event: FormEvent) {
    event.preventDefault()
    const username = resetUser
    if (!username || !begin('reset-password')) return
    try {
      await api<{ user: AdminUser }>(`/admin/users/${encodeURIComponent(username)}`, { method: 'PATCH', csrf: session.csrf_token, body: { password: resetPassword } })
      setResetPassword(''); setResetUser(null)
      if (username === session.user?.username) onSessionInvalidated('Your password was updated. Log in again with your new password.')
      else setSuccess(`${displayName(username)}’s password was updated and their existing sessions were signed out.`)
    } catch (err) { setDialogError(message(err)) }
    finally { setBusy(null) }
  }
  async function saveParticipants(event: FormEvent) {
    event.preventDefault()
    const selectedAssignment = assignment
    if (!selectedAssignment || !assignmentReady || !begin('participants')) return
    try {
      const result = await api<{ participants: string[] }>(`/admin/competitions/${selectedAssignment.competitionId}/participants`, { method: 'PUT', csrf: session.csrf_token, body: { participants: selectedAssignment.selected } })
      setAssignment({ competitionId: selectedAssignment.competitionId, original: result.participants, selected: result.participants }); setSuccess('Run participants were updated.')
    } catch (err) { setError(message(err)) }
    finally { setBusy(null) }
  }
  function reviewCompetition(event: FormEvent) {
    event.preventDefault()
    if (!current || !(newParticipants?.length)) return
    setDialogError(''); setError(''); setSuccess('')
    setPendingCompetition({ expected_current_id: current.id, previousName: current.name, participants: [...newParticipants], ...(competitionName.trim() ? { name: competitionName.trim() } : {}) })
  }
  async function createCompetition() {
    const pending = pendingCompetition
    if (!pending || !begin('competition')) return
    try {
      const { previousName: _previousName, ...body } = pending
      const result = await api<{ competition: Competition; current_id: number }>('/competitions', { method: 'POST', csrf: session.csrf_token, body })
      setPendingCompetition(null); navigate(`/runs/${result.competition.id}`)
    } catch (err) { setDialogError(message(err)) }
    finally { setBusy(null) }
  }

  if (!session.user) return <section className="management"><div className="empty-panel"><h2>Administration</h2><p>Log in as Lukas to manage players and runs.</p><button className="button button-gold" onClick={onLogin}>Player login</button></div></section>
  if (!canManage) return <section className="management"><div className="empty-panel"><h2>Administration is reserved for Lukas.</h2><p>Your run is waiting on the leaderboard.</p><button className="button button-outline" onClick={() => navigate('/')}>Return to leaderboard</button></div></section>

  return <section className="management" aria-labelledby="admin-title">
    <div className="section-heading"><div><p className="eyebrow">THE LEDGER</p><h2 id="admin-title">Administration</h2></div><span className="run-tag">Lukas · Administrator</span></div>
    <div className="admin-tabs" role="tablist" aria-label="Administration sections"><button role="tab" aria-selected={tab === 'competitions'} aria-controls="admin-competitions" id="competitions-tab" onClick={() => setTab('competitions')}>Runs</button><button role="tab" aria-selected={tab === 'users'} aria-controls="admin-users" id="users-tab" onClick={() => setTab('users')}>Users</button></div>
    {error && <div className="error-banner" role="alert">{error}<button className="text-button" onClick={() => setError('')}>Dismiss</button></div>}
    {success && <div className="success-banner" role="status">{success}</div>}
    {loading && <p className="admin-loading" role="status">Loading administration…</p>}

    {tab === 'users' ? <div id="admin-users" role="tabpanel" aria-labelledby="users-tab">
      <form className="admin-panel create-user-form" onSubmit={event => void createUser(event)}><h3>Create a player</h3><p>Use 3–32 lowercase letters, numbers, underscores, or hyphens. Usernames stay fixed after creation. Passwords need at least 12 characters.</p><div className="admin-form-grid"><div><label className="form-label" htmlFor="new-username">Username</label><input className="form-input" id="new-username" value={newUsername} onChange={event => setNewUsername(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} required minLength={3} maxLength={32} pattern="[a-z0-9_-]{3,32}" disabled={loading || Boolean(busy)}/></div><div><label className="form-label" htmlFor="new-user-password">Initial password</label><input className="form-input" id="new-user-password" type="password" value={newPassword} onChange={event => setNewPassword(event.target.value)} autoComplete="new-password" required minLength={12} disabled={loading || Boolean(busy)}/></div></div><button className="button button-gold" disabled={loading || Boolean(busy) || !newUsername.trim() || newPassword.length < 12} type="submit">{busy === 'create-user' ? 'Creating…' : 'Create user'}</button></form>
      <div className="admin-user-list">{users.map(user => <article className="admin-user-row" key={user.username}><span className="account-avatar">{user.username[0].toUpperCase()}</span><div className="admin-user-copy"><h3>{displayName(user.username)}</h3><span>{user.can_manage ? 'Administrator' : 'Player'} · {user.active ? 'Enabled' : 'Disabled'}</span></div><div className="admin-user-actions"><button className="button button-outline button-small" onClick={() => { setDialogError(''); setResetPassword(''); setResetUser(user.username) }} disabled={Boolean(busy)} aria-label={`Reset password for ${user.username}`}>Reset password</button><button className="button button-outline button-small" onClick={() => void setActive(user)} disabled={Boolean(busy) || user.can_manage} aria-label={`${user.active ? 'Disable' : 'Enable'} ${user.username}`} title={user.can_manage ? 'The administrator cannot be disabled.' : undefined}>{user.active ? 'Disable' : 'Enable'}</button></div></article>)}</div>
    </div> : <div id="admin-competitions" role="tabpanel" aria-labelledby="competitions-tab">
      <form className="admin-panel" onSubmit={reviewCompetition}><h3>Open the next run</h3><p>Choose its players. Creating it archives {current?.name ?? 'the current run'} and preserves every old leaderboard and checklist.</p><label className="form-label" htmlFor="competition-name">Run name <span className="optional-label">optional</span></label><input className="form-input" id="competition-name" placeholder={`Run ${(current?.number ?? 0) + 1}`} value={competitionName} onChange={event => setCompetitionName(event.target.value)} maxLength={80} disabled={Boolean(busy)}/><ParticipantPicker users={users} selected={newParticipants ?? []} onChange={setNewParticipants} disabled={loading || Boolean(busy)} label="Players in the new run"/><button type="submit" className="button button-gold" disabled={loading || Boolean(busy) || !current || !(newParticipants?.length)}>Create next run</button></form>
      {current && <form className="admin-panel" onSubmit={event => void saveParticipants(event)}><h3>Players in {current.name}</h3><p>Players who have started an attempt cannot be removed. Archived runs remain read-only.</p><ParticipantPicker users={users} selected={assignmentReady ? assignment!.selected : []} existing={assignmentReady ? assignment!.original : []} onChange={selected => setAssignment(previous => previous && { ...previous, selected })} disabled={loading || Boolean(busy) || !assignmentReady} label="Current run players"/><button className="button button-outline" type="submit" disabled={loading || Boolean(busy) || !assignmentReady || !assignment?.selected.length}>{busy === 'participants' ? 'Saving…' : 'Save participants'}</button></form>}
      <div className="admin-history-heading"><h3>Run archive</h3><p>Every leaderboard remains publicly available.</p></div><div className="competition-history">{competitions.competitions.map(item => <a className="history-row" key={item.id} href={`/runs/${item.id}`} onClick={event => { event.preventDefault(); navigate(`/runs/${item.id}`) }}><span className="history-number">{String(item.number).padStart(2, '0')}</span><div><h3>{item.name}</h3><span>Opened {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(item.created_at))}</span></div><span className={`chapter-badge ${item.status}`}>{item.status === 'current' ? 'Current' : 'Archived'}</span><span aria-hidden="true">→</span></a>)}</div>
    </div>}

    {resetUser && <Modal title={`Reset ${displayName(resetUser)}’s password`} onClose={() => setResetUser(null)} busy={Boolean(busy)}><p className="modal-description">Existing sessions will be signed out.{resetUser === session.user?.username ? ' You will need to log in again.' : ''}</p><form onSubmit={event => void changePassword(event)}><label className="form-label" htmlFor="reset-password">New password</label><input className="form-input" id="reset-password" type="password" autoComplete="new-password" value={resetPassword} onChange={event => setResetPassword(event.target.value)} required minLength={12} disabled={Boolean(busy)}/>{dialogError && <p className="form-error" role="alert">{dialogError}</p>}<button className="button button-gold modal-submit" type="submit" disabled={Boolean(busy) || resetPassword.length < 12}>{busy === 'reset-password' ? 'Updating…' : 'Reset password'}</button></form></Modal>}
    {pendingCompetition && <Modal title="Open a new chapter?" onClose={() => setPendingCompetition(null)} busy={Boolean(busy)}><p className="modal-description">{pendingCompetition.previousName} will be archived. The selected players receive a fresh attempt in {pendingCompetition.name ?? `Run ${(current?.number ?? 0) + 1}`}. All old scores, life statuses, and checklists will stay visible and read-only.</p><p className="confirmation-players">Players: {pendingCompetition.participants.map(displayName).join(', ')}</p>{dialogError && <p className="form-error" role="alert">{dialogError}</p>}<div className="modal-actions"><button className="button button-outline" onClick={() => setPendingCompetition(null)} disabled={Boolean(busy)}>Cancel</button><button className="button button-gold" onClick={() => void createCompetition()} disabled={Boolean(busy)}>{busy === 'competition' ? 'Creating…' : 'Create next run'}</button></div></Modal>}
  </section>
}
