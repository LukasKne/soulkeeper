import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import type { Competition, Encounter, PracticeView, RunProgress } from './types'

const catalog = [
  { id: 'boss', name: 'Asylum Demon', kind: 'boss', points: 5 },
  { id: 'mini', name: 'Black Knight', kind: 'miniboss', points: 3 },
  { id: 'shared', name: 'Shared Demon', kind: 'boss', points: 5 },
].map(entry => ({ ...entry, area_id: 'asylum', area_name: 'Northern Undead Asylum', area_order: 1, description: 'Test encounter', defeated: false })) as Encounter[]
const run = (id: number): Competition => ({ id, number: id, name: `Run ${id}`, status: id === 2 ? 'current' : 'archived', max_points: id === 2 ? 13 : 5, created_at: '2026-10-01T00:00:00Z', archived_at: id === 1 ? '2026-10-02T00:00:00Z' : null })

function server(initialUser: string | null = null) {
  let user = initialUser
  let generation = 0
  let draft: PracticeView | null = null
  let history: PracticeView[] = []
  const writes: { path: string; method: string; body: unknown; csrf?: string }[] = []
  const calls: string[] = []
  const session = () => ({ user: user ? { username: user, can_manage: user === 'lukas' } : null, csrf_token: user ? 'csrf' : null })
  function progress(id: number): RunProgress {
    const entries = id === 2 ? catalog : catalog.slice(0, 1)
    return { competition: run(id), encounters: entries, players: ['lukas', 'oli'].map(username => {
      const defeated_ids = id === 2 ? [username === 'lukas' ? 'boss' : 'mini'] : []
      const checked = entries.filter(entry => defeated_ids.includes(entry.id))
      const totals = { points: checked.reduce((sum, entry) => sum + entry.points, 0), bosses_defeated: checked.filter(entry => entry.kind === 'boss').length, minibosses_defeated: checked.filter(entry => entry.kind === 'miniboss').length }
      return { username, attempt_status: 'active', attempt: { ...totals, status: 'active', started_at: '2026-10-01T00:00:00Z', ended_at: null }, ...totals, defeated_ids }
    }) }
  }
  function fresh() {
    generation += 1
    draft = { id: `draft-${generation}`, username: user!, created_at: '2026-10-01T00:00:00Z', saved_at: null, outcome: null, points: 0, bosses_defeated: 0, minibosses_defeated: 0, max_points: 13, encounters: catalog.map(entry => ({ ...entry })) }
    return draft
  }
  const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input).replace(/^\/api/, '')
    const method = options?.method ?? 'GET'
    const body = options?.body ? JSON.parse(String(options.body)) : undefined
    calls.push(path)
    if (method !== 'GET') writes.push({ path, method, body, csrf: (options?.headers as Record<string, string>)?.['X-CSRF-Token'] })
    if (path === '/session') return reply(session())
    if (path === '/login') { user = body.username; return reply(session()) }
    if (path === '/logout') { user = null; return reply(session()) }
    if (path === '/competitions') return reply({ competitions: [run(2), run(1)], current_id: 2 })
    const official = path.match(/^\/competitions\/(\d+)\/(progress|leaderboard|attempt)$/)
    if (official) {
      const result = progress(Number(official[1]))
      if (official[2] === 'progress') return reply(result)
      if (official[2] === 'leaderboard') return reply({ competition: result.competition, max_points: result.competition.max_points, players: result.players.map((entry, index) => ({ ...entry, rank: index + 1 })) })
      const player = result.players.find(entry => entry.username === user)!
      return reply({ competition: result.competition, attempt: player.attempt, encounters: result.encounters.map(entry => ({ ...entry, defeated: player.defeated_ids.includes(entry.id) })) })
    }
    const profile = path.match(/^\/players\/(\w+)\/runs$/)
    if (profile) return reply({ username: profile[1], runs: [2, 1].map(id => { const result = progress(id); return { ...result.players.find(entry => entry.username === profile[1]), competition: result.competition } }) })
    if (path.startsWith('/practice') && !user) return reply({ detail: 'Please sign in' }, 401)
    if (path === '/practice') {
      if (method === 'POST') return reply(draft ?? fresh())
      return draft ? reply(draft) : reply({ detail: 'No draft' }, 404)
    }
    if (path === '/practice/history') {
      if (method === 'DELETE') { const count = history.length; history = []; return reply({ deleted: count }) }
      return reply({ attempts: history.map(({ encounters: _entries, ...summary }) => summary) })
    }
    if (path.startsWith('/practice/history/')) {
      const id = path.split('/').at(-1)!
      const record = history.find(item => item.id === id)
      if (!record) return reply({ detail: 'Saved practice not found' }, 404)
      if (method === 'DELETE') { history = history.filter(item => item.id !== id); return reply({ deleted: 1 }) }
      return reply(record)
    }
    const mutation = path.match(/^\/practice\/([^/]+)\/(encounters\/(.+)|save|reset)$/)
    if (mutation) {
      if (draft?.id !== mutation[1]) return reply({ detail: 'Your practice draft changed. Refresh before continuing' }, 409)
      if (mutation[2] === 'reset') return reply(fresh())
      if (mutation[2] === 'save') {
        const saved = { ...draft, encounters: draft.encounters.map(entry => ({ ...entry })), id: `history-${generation}`, outcome: body.outcome, saved_at: '2026-10-02T12:00:00Z' }
        history.unshift(saved)
        return reply({ draft: fresh(), saved })
      }
      draft.encounters = draft.encounters.map(entry => entry.id === mutation[3] ? { ...entry, defeated: body.defeated } : entry)
      const checked = draft.encounters.filter(entry => entry.defeated)
      draft.points = checked.reduce((sum, entry) => sum + entry.points, 0)
      draft.bosses_defeated = checked.filter(entry => entry.kind === 'boss').length
      draft.minibosses_defeated = checked.filter(entry => entry.kind === 'miniboss').length
      return reply(draft)
    }
    return reply({ detail: 'Not found' }, 404)
  })
  return { fetchMock, calls, writes, externalReset: fresh, getHistory: () => history }
}

beforeEach(() => { window.history.replaceState({}, '', '/'); vi.stubGlobal('scrollTo', vi.fn()) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Public runs, comparison, and private practice', () => {
  it('navigates from a public player name to history and a read-only checklist', async () => {
    const api = server(); vi.stubGlobal('fetch', api.fetchMock)
    render(<App />)
    await userEvent.click(await screen.findByRole('link', { name: 'Lukas' }))
    expect(await screen.findByRole('heading', { name: 'Lukas’s runs' })).toBeInTheDocument()
    await userEvent.click((await screen.findAllByRole('link', { name: 'View checklist →' }))[0])
    const box = await screen.findByRole('checkbox', { name: /Asylum Demon/ })
    expect(box).toBeChecked(); expect(box).toBeDisabled()
    expect(window.location.pathname).toBe('/runs/2/players/lukas')
    expect(api.writes).toHaveLength(0)
  })

  it('compares players publicly and filters matching encounters without allowing edits', async () => {
    const api = server(); vi.stubGlobal('fetch', api.fetchMock); window.history.replaceState({}, '', '/compare?run=2')
    render(<App />)
    expect(await screen.findByText('Lukas leads by 2 points')).toBeInTheDocument()
    const table = screen.getByRole('table', { name: 'Encounter comparison' })
    expect(within(table).getByText('Shared Demon')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Differences only' }))
    expect(within(table).queryByText('Shared Demon')).not.toBeInTheDocument()
    expect(within(table).getByText('Asylum Demon')).toBeInTheDocument()
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search comparison' }), 'Black Knight')
    expect(within(table).queryByText('Asylum Demon')).not.toBeInTheDocument()
    expect(within(table).getByText('Black Knight')).toBeInTheDocument()
    expect(within(table).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(api.writes).toHaveLength(0)
  })

  it('compares historical catalogs by encounter ID and represents missing entries explicitly', async () => {
    const api = server(); vi.stubGlobal('fetch', api.fetchMock); window.history.replaceState({}, '', '/compare?mode=history&player=lukas&left=run:2&right=run:1')
    render(<App />)
    await screen.findByRole('table', { name: 'Encounter comparison' })
    expect(screen.getAllByText('Not in this run')).toHaveLength(2)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'First attempt' }), 'run:1')
    expect(window.location.search).toContain('left=run%3A1')
    expect(await screen.findByText('Choose two different attempts to compare.')).toBeInTheDocument()
  })

  it('keeps private practice comparisons behind the owner account', async () => {
    const api = server(); vi.stubGlobal('fetch', api.fetchMock); window.history.replaceState({}, '', '/compare?mode=history&player=oli&left=practice:private-id')
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('only available to their owner')
    expect(api.calls.some(path => path.startsWith('/practice'))).toBe(false)
  })

  it('saves practice on death, resets without saving, and confirms individual and bulk deletion', async () => {
    const api = server('oli'); vi.stubGlobal('fetch', api.fetchMock); window.history.replaceState({}, '', '/practice')
    render(<App />)
    let box = await screen.findByRole('checkbox', { name: /Asylum Demon/ })
    await userEvent.click(box)
    await waitFor(() => expect(box).toBeEnabled())
    expect(box).toBeChecked()
    fireEvent.focus(window)
    await waitFor(() => expect(api.calls.filter(path => path === '/practice').length).toBeGreaterThan(2))
    expect(box).toBeChecked()
    expect(api.writes.find(write => write.method === 'PUT')).toMatchObject({ csrf: 'csrf', body: { defeated: true } })
    await userEvent.click(screen.getByRole('button', { name: 'Died' }))
    await screen.findByText('Practice saved to your private history. Your new checklist is ready.')
    box = screen.getByRole('checkbox', { name: /Asylum Demon/ })
    await waitFor(() => expect(box).toBeEnabled())
    expect(box).not.toBeChecked(); expect(api.getHistory()[0].points).toBe(5)
    await userEvent.click(box); await waitFor(() => expect(box).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Reset all' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset all' }))
    await screen.findByText('Practice reset. No history entry was saved.')
    expect(api.getHistory()).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'End' }))
    await waitFor(() => expect(api.getHistory()).toHaveLength(2))
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2))
    await userEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0])
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(api.getHistory()).toHaveLength(2)
    await userEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0])
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete practice' }))
    await waitFor(() => expect(api.getHistory()).toHaveLength(1))
    await userEvent.click(screen.getByRole('button', { name: 'Delete all practice history' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete all practice history' }))
    await waitFor(() => expect(api.getHistory()).toHaveLength(0))
    expect(api.writes.some(write => write.path.startsWith('/competitions/'))).toBe(false)
  })

  it('refreshes a stale practice draft after a rejected checkbox write', async () => {
    const api = server('oli'); vi.stubGlobal('fetch', api.fetchMock); window.history.replaceState({}, '', '/practice')
    render(<App />)
    const box = await screen.findByRole('checkbox', { name: /Asylum Demon/ })
    api.externalReset()
    await userEvent.click(box)
    await waitFor(() => expect(box).toBeEnabled())
    expect(box).not.toBeChecked()
    expect(screen.getByRole('alert')).toHaveTextContent('Your practice draft changed')
    expect(api.getHistory()).toHaveLength(0)
  })

  it('includes saved practice in the owner comparison and clears it on sign-out', async () => {
    const api = server('oli'); vi.stubGlobal('fetch', api.fetchMock); window.history.replaceState({}, '', '/practice')
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Died' }))
    const history = screen.getByRole('region', { name: 'Practice history' })
    await userEvent.click(await within(history).findByRole('link', { name: 'Compare →' }))
    await screen.findByRole('table', { name: 'Encounter comparison' })
    expect(screen.getByRole('combobox', { name: 'First attempt' })).toHaveValue('practice:history-1')
    expect(screen.getByText('Practice · Died')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Log out' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('only available to their owner'))
    expect(screen.queryByText('Practice · Died')).not.toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'Encounter comparison' })).not.toBeInTheDocument()
  })
})
