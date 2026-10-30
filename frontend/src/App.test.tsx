import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import type { AdminUser, AttemptView, Competition, Session, Username } from './types'

const makeCompetition = (id: number, status: Competition['status']): Competition => ({ id, number: id, name: `Competition ${id}`, status, created_at: '2026-10-29T12:00:00Z', archived_at: status === 'archived' ? '2026-10-30T12:00:00Z' : null, max_points: 310 })

function makeServer(initialUser: Username | null = null) {
  let user = initialUser
  let current = 2
  let competitions = [makeCompetition(2, 'current'), makeCompetition(1, 'archived')]
  let saveFails = false
  let assigned = true
  const users: AdminUser[] = [{ username: 'lukas', active: true, can_manage: true }, { username: 'oli', active: true, can_manage: false }]
  const participants: Record<number, string[]> = { 1: ['lukas', 'oli'], 2: ['lukas', 'oli'] }
  const writes: { path: string; body: unknown; csrf: string | undefined }[] = []
  const attempts: Record<number, AttemptView['attempt']> = {
    1: { status: 'active', points: 5, bosses_defeated: 1, minibosses_defeated: 0, started_at: '2026-10-29T12:00:00Z', ended_at: null },
    2: { status: 'active', points: 0, bosses_defeated: 0, minibosses_defeated: 0, started_at: '2026-10-29T12:00:00Z', ended_at: null },
  }
  const checked: Record<number, boolean> = { 1: true, 2: false }
  const session = (): Session => ({ user: user ? { username: user, can_manage: user === 'lukas' } : null, csrf_token: user ? 'test-csrf-token' : null })
  const own = (id: number): AttemptView => ({ competition: competitions.find(item => item.id === id)!, attempt: attempts[id] ?? null, encounters: [{ id: 'asylum-demon', area_id: 'asylum', area_name: 'Northern Undead Asylum', area_order: 1, name: 'Asylum Demon', description: 'Courtyard encounter', kind: 'boss', points: 5, defeated: checked[id] ?? false }] })
  const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input).replace(/^\/api/, '')
    const method = options?.method ?? 'GET'
    const body = options?.body ? JSON.parse(String(options.body)) : undefined
    if (method !== 'GET') writes.push({ path, body, csrf: (options?.headers as Record<string, string>)?.['X-CSRF-Token'] })
    if (path === '/session') return reply(session())
    if (path === '/login') { if (body.password !== 'correct-password') return reply({ detail: 'Invalid credentials' }, 401); user = body.username; return reply(session()) }
    if (path === '/logout') { user = null; return reply(session()) }
    if (path === '/admin/users' && method === 'GET') return reply({ users })
    if (path === '/admin/users' && method === 'POST') {
      if (users.some(item => item.username === body.username)) return reply({ detail: 'That username already exists.' }, 409)
      const next = { username: body.username, active: true, can_manage: false }; users.push(next); return reply({ user: next }, 201)
    }
    const patch = path.match(/^\/admin\/users\/(.+)$/)
    if (patch && method === 'PATCH') {
      const account = users.find(item => item.username === patch[1])!
      if ('active' in body) account.active = body.active
      if (body.password && account.username === user) user = null
      return reply({ user: account })
    }
    const memberPath = path.match(/^\/admin\/competitions\/(\d+)\/participants$/)
    if (memberPath) {
      const id = Number(memberPath[1])
      if (method === 'PUT') {
        if (participants[id].includes('lukas') && !body.participants.includes('lukas')) return reply({ detail: 'Cannot remove a player who has started an attempt.' }, 409)
        participants[id] = body.participants
      }
      return reply({ participants: participants[id] })
    }
    if (path === '/competitions' && method === 'GET') return reply({ competitions, current_id: current })
    if (path === '/competitions' && method === 'POST') {
      if (body.expected_current_id !== current) return reply({ detail: 'The current competition changed.' }, 409)
      competitions = competitions.map(item => ({ ...item, status: 'archived', archived_at: '2026-10-30T12:00:00Z' }))
      current += 1; competitions.unshift({ ...makeCompetition(current, 'current'), name: body.name || `Competition ${current}` }); attempts[current] = null; participants[current] = body.participants
      return reply({ competition: competitions[0], current_id: current })
    }
    const match = path.match(/^\/competitions\/(\d+)\/(.*)$/)
    if (!match) return reply({ detail: 'Not found' }, 404)
    const id = Number(match[1]), action = match[2]
    const competition = competitions.find(item => item.id === id)!
    if (action === 'leaderboard') return reply({ competition, max_points: 310, players: participants[id].map(username => username === 'oli' ?
      { username, rank: 1, attempt_status: 'failed', points: 13, bosses_defeated: 2, minibosses_defeated: 1 } :
      { username, rank: 1, attempt_status: attempts[id]?.status ?? 'not_started', points: attempts[id]?.points ?? 0, bosses_defeated: attempts[id]?.bosses_defeated ?? 0, minibosses_defeated: 0 }),
    })
    if (action === 'attempt') return assigned && participants[id].includes(user!) ? reply(own(id)) : reply({ detail: 'You are not assigned to this competition.' }, 403)
    if (action === 'attempt/encounters/asylum-demon') {
      if (saveFails) return reply({ detail: 'Could not save this victory. Please try again.' }, 503)
      if (competition.status === 'archived') return reply({ detail: 'This competition is archived.' }, 409)
      checked[id] = body.defeated
      attempts[id] = { ...attempts[id]!, points: body.defeated ? 5 : 0, bosses_defeated: body.defeated ? 1 : 0 }
      return reply(own(id))
    }
    if (action === 'attempt/finish') { attempts[id] = { ...attempts[id]!, status: body.outcome, ended_at: '2026-10-30T12:00:00Z' }; return reply(own(id)) }
    if (action === 'attempt/start') { attempts[id] = { status: 'active', points: 0, bosses_defeated: 0, minibosses_defeated: 0, started_at: '2026-10-29T12:00:00Z', ended_at: null }; return reply(own(id)) }
    return reply({ detail: 'Not found' }, 404)
  })
  return { fetchMock, writes, failSaves: () => { saveFails = true }, removeAssignment: () => { assigned = false }, archiveCurrent: () => { competitions[0] = { ...competitions[0], status: 'archived' }; current += 1; competitions.unshift(makeCompetition(current, 'current')); attempts[current] = null; participants[current] = ['lukas', 'oli'] } }
}

beforeEach(() => { window.history.replaceState({}, '', '/'); vi.stubGlobal('scrollTo', vi.fn()) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Soulkeeper journeys', () => {
  it('keeps archived leaderboards in the visible selector with permanent links', async () => {
    const server = makeServer(); vi.stubGlobal('fetch', server.fetchMock)
    render(<App />)
    const select = await screen.findByRole('combobox', { name: 'Browse competitions' })
    await waitFor(() => expect(select).toHaveValue('2'))
    expect(within(select).getByRole('option', { name: 'Competition 1 · Archived' })).toBeInTheDocument()
    await userEvent.selectOptions(select, '1')
    expect(await screen.findByText('This chapter is preserved.')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/competitions/1')
    expect(screen.getByText('Archived leaderboard')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /View current competition/ })).toBeInTheDocument()
  })

  it('logs in and saves an owned checkbox with the session CSRF token', async () => {
    const server = makeServer(); vi.stubGlobal('fetch', server.fetchMock)
    render(<App />)
    await screen.findByText('The challengers')
    await userEvent.click(screen.getByRole('button', { name: 'Player login' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Password'), 'correct-password')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Enter the ledger' }))
    const encounter = await screen.findByRole('checkbox', { name: /Asylum Demon/ })
    await userEvent.click(encounter)
    await waitFor(() => expect(encounter).toBeChecked())
    await waitFor(() => expect(encounter).toBeEnabled())
    expect(server.writes.find(write => write.path.endsWith('/encounters/asylum-demon'))).toEqual({ path: '/competitions/2/attempt/encounters/asylum-demon', body: { defeated: true }, csrf: 'test-csrf-token' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('rolls back a failed save and keeps the error visible after the server refresh', async () => {
    const server = makeServer('lukas'); server.failSaves(); vi.stubGlobal('fetch', server.fetchMock)
    render(<App />)
    const encounter = await screen.findByRole('checkbox', { name: /Asylum Demon/ })
    await userEvent.click(encounter)
    await waitFor(() => expect(encounter).toBeEnabled())
    expect(encounter).not.toBeChecked()
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save this victory. Please try again.')
    fireEvent.focus(window)
    await waitFor(() => expect(server.fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/attempt')).length).toBeGreaterThan(2))
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save this victory. Please try again.')
  })

  it('lets a player reopen an archived checklist without enabling changes', async () => {
    const server = makeServer('lukas'); vi.stubGlobal('fetch', server.fetchMock); window.history.replaceState({}, '', '/competitions/1')
    render(<App />)
    const encounter = await screen.findByRole('checkbox', { name: /Asylum Demon/ })
    expect(encounter).toBeDisabled(); expect(encounter).toBeChecked()
    expect(screen.getByText('Archived · Read-only')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'I died' })).not.toBeInTheDocument()
    expect(screen.getAllByText('Alive').length).toBeGreaterThan(0)
  })

  it('locks a stale tab when its competition is archived without changing the selected competition', async () => {
    const server = makeServer('lukas'); vi.stubGlobal('fetch', server.fetchMock)
    render(<App />)
    const encounter = await screen.findByRole('checkbox', { name: /Asylum Demon/ })
    expect(encounter).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'I died' }))
    server.archiveCurrent(); fireEvent.focus(window)
    await screen.findByText('This chapter is preserved.')
    expect(encounter).toBeDisabled()
    expect(window.location.pathname).toBe('/competitions/2')
    expect(screen.getByRole('combobox', { name: 'Browse competitions' })).toHaveValue('2')
    expect(screen.getByRole('option', { name: 'Competition 3 · Current' })).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm death' })).toBeDisabled()
  })

  it('confirms death before permanently showing the attempt as read-only', async () => {
    const server = makeServer('lukas'); vi.stubGlobal('fetch', server.fetchMock)
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'I died' }))
    expect(server.writes).toHaveLength(0)
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm death' }))
    await screen.findByText('Attempt ended · Read-only')
    expect(screen.getByRole('checkbox', { name: /Asylum Demon/ })).toBeDisabled()
    expect(server.writes).toContainEqual({ path: '/competitions/2/attempt/finish', body: { outcome: 'failed' }, csrf: 'test-csrf-token' })
    expect(screen.queryByRole('button', { name: 'Start my attempt' })).not.toBeInTheDocument()
  })

  it('opens the next competition from the separate management page and preserves the old entry', async () => {
    const server = makeServer('lukas'); vi.stubGlobal('fetch', server.fetchMock)
    render(<App />)
    await userEvent.click(await screen.findByRole('link', { name: 'Admin' }))
    await userEvent.click(await screen.findByRole('button', { name: /Create next competition/ }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('All old scores, life statuses, and checklists will stay visible and read-only.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create next competition' }))
    await screen.findByRole('button', { name: /Start my attempt/ })
    expect(window.location.pathname).toBe('/competitions/3')
    expect(screen.getByRole('option', { name: 'Competition 2 · Archived' })).toBeInTheDocument()
    expect(server.writes).toContainEqual({ path: '/competitions', body: { expected_current_id: 2, participants: ['lukas', 'oli'] }, csrf: 'test-csrf-token' })
  })

  it('accepts an arbitrary player login and keeps administration out of the player navigation', async () => {
    const server = makeServer(); vi.stubGlobal('fetch', server.fetchMock)
    render(<App />)
    await screen.findByText('The challengers')
    await userEvent.click(screen.getByRole('button', { name: 'Player login' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.clear(within(dialog).getByLabelText('Username'))
    await userEvent.type(within(dialog).getByLabelText('Username'), 'charlie')
    await userEvent.type(within(dialog).getByLabelText('Password'), 'correct-password')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Enter the ledger' }))
    await screen.findByText('You are not assigned to this competition.')
    expect(server.writes).toContainEqual({ path: '/login', body: { username: 'charlie', password: 'correct-password' }, csrf: undefined })
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument()
    expect(screen.getByText('The challengers')).toBeInTheDocument()
  })

  it('clears a stale editable checklist when polling detects removed membership', async () => {
    const server = makeServer('lukas'); vi.stubGlobal('fetch', server.fetchMock)
    render(<App />)
    expect(await screen.findByRole('checkbox', { name: /Asylum Demon/ })).toBeEnabled()
    server.removeAssignment(); fireEvent.focus(window)
    await screen.findByText('You are not assigned to this competition.')
    expect(screen.queryByRole('checkbox', { name: /Asylum Demon/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'I died' })).not.toBeInTheDocument()
    expect(screen.getByText('The challengers')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('creates players, reports duplicate errors, resets a password, and disables without deleting records', async () => {
    const server = makeServer('lukas'); vi.stubGlobal('fetch', server.fetchMock); window.history.replaceState({}, '', '/admin')
    render(<App />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Users' }))
    await userEvent.type(screen.getByLabelText('Username'), 'charlie')
    await userEvent.type(screen.getByLabelText('Initial password'), 'new-player-password')
    await userEvent.click(screen.getByRole('button', { name: 'Create user' }))
    await screen.findByText('Charlie was created. Assign them to a competition to let them play.')
    expect(screen.getByRole('button', { name: 'Disable lukas' })).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Username'), 'charlie')
    await userEvent.type(screen.getByLabelText('Initial password'), 'another-password')
    await userEvent.click(screen.getByRole('button', { name: 'Create user' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That username already exists.')
    await userEvent.click(screen.getByRole('button', { name: 'Reset password for charlie' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('New password'), 'replacement-password')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reset password' }))
    await screen.findByText('Charlie’s password was updated and their existing sessions were signed out.')
    await userEvent.click(screen.getByRole('button', { name: 'Disable charlie' }))
    await screen.findByText('Charlie is disabled. Existing competition records are preserved.')
    expect(screen.getByRole('button', { name: 'Enable charlie' })).toBeEnabled()
    expect(server.writes).toContainEqual({ path: '/admin/users/charlie', body: { password: 'replacement-password' }, csrf: 'test-csrf-token' })
    expect(server.writes).toContainEqual({ path: '/admin/users/charlie', body: { active: false }, csrf: 'test-csrf-token' })
  })

  it('returns to login with success feedback after the administrator resets their own password', async () => {
    const server = makeServer('lukas'); vi.stubGlobal('fetch', server.fetchMock); window.history.replaceState({}, '', '/admin')
    render(<App />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Users' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Reset password for lukas' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('New password'), 'replacement-password')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reset password' }))
    await screen.findByText('Your password was updated. Log in again with your new password.')
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Player login' }).length).toBeGreaterThan(0)
  })

  it('edits current participants and shows the server refusal to remove a started player', async () => {
    const server = makeServer('lukas'); vi.stubGlobal('fetch', server.fetchMock); window.history.replaceState({}, '', '/manage')
    render(<App />)
    const group = await screen.findByRole('group', { name: 'Current competition players' })
    const oli = await within(group).findByRole('checkbox', { name: 'Oli' })
    await userEvent.click(oli)
    await userEvent.click(screen.getByRole('button', { name: 'Save participants' }))
    await screen.findByText('Competition participants were updated.')
    expect(server.writes).toContainEqual({ path: '/admin/competitions/2/participants', body: { participants: ['lukas'] }, csrf: 'test-csrf-token' })
    await userEvent.click(oli)
    await userEvent.click(within(group).getByRole('checkbox', { name: 'Lukas' }))
    fireEvent.focus(window)
    await userEvent.click(screen.getByRole('button', { name: 'Save participants' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot remove a player who has started an attempt.')
    expect(within(group).getByRole('checkbox', { name: 'Lukas' })).not.toBeChecked()
  })

  it('creates a named competition with only the selected participants', async () => {
    const server = makeServer('lukas'); vi.stubGlobal('fetch', server.fetchMock); window.history.replaceState({}, '', '/admin')
    render(<App />)
    const group = await screen.findByRole('group', { name: 'Players in the new competition' })
    await userEvent.click(await within(group).findByRole('checkbox', { name: 'Lukas' }))
    await userEvent.type(screen.getByLabelText(/Competition name/), 'No Death Friday')
    await userEvent.click(screen.getByRole('button', { name: 'Create next competition' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Players: Oli')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create next competition' }))
    await screen.findByText('You are not assigned to this competition.')
    expect(screen.getByRole('heading', { name: 'No Death Friday' })).toBeInTheDocument()
    expect(server.writes).toContainEqual({ path: '/competitions', body: { expected_current_id: 2, participants: ['oli'], name: 'No Death Friday' }, csrf: 'test-csrf-token' })
  })
})
