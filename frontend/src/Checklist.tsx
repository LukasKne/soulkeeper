import { useMemo, useState } from 'react'
import type { Encounter } from './types'
import Chevron from './Chevron'

export default function Checklist({ encounters, editable = false, busy = false, onToggle }: {
  encounters: Encounter[]; editable?: boolean; busy?: boolean; onToggle?: (entry: Encounter) => void
}) {
  const [search, setSearch] = useState('')
  const [remaining, setRemaining] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const groups = useMemo(() => {
    const areas = new Map<string, { id: string; name: string; order: number; entries: Encounter[] }>()
    for (const entry of encounters) {
      if (!areas.has(entry.area_id)) areas.set(entry.area_id, { id: entry.area_id, name: entry.area_name, order: entry.area_order, entries: [] })
      areas.get(entry.area_id)!.entries.push(entry)
    }
    return [...areas.values()].sort((a, b) => a.order - b.order)
  }, [encounters])
  const needle = search.trim().toLowerCase()
  const filtered = groups.map(group => ({ ...group, visible: group.entries.filter(entry => (!remaining || !entry.defeated) && (!needle || `${entry.name} ${entry.area_name} ${entry.description}`.toLowerCase().includes(needle))) })).filter(group => group.visible.length)
  return <>
    <div className="ledger-filters">
      <div className="search-wrap"><input type="search" aria-label="Search encounters or locations" placeholder="Search encounters or locations…" value={search} onChange={event => setSearch(event.target.value)}/></div>
      <label className="remaining-toggle"><input type="checkbox" checked={remaining} onChange={event => setRemaining(event.target.checked)}/><span className="toggle-switch"/>Remaining only</label>
      <button className="text-button collapse-button" onClick={() => setCollapsed(collapsed.size === groups.length ? new Set() : new Set(groups.map(group => group.id)))}>{collapsed.size === groups.length ? 'Expand all' : 'Collapse all'}</button>
    </div>
    <div className="area-list">{filtered.map(group => {
      const expanded = !collapsed.has(group.id) || Boolean(needle)
      return <section className="area" key={group.id}>
        <button className="area-heading" aria-expanded={expanded} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next })}>
          <span className="area-index">{String(group.order).padStart(2, '0')}</span><h3>{group.name}</h3><span className="area-progress">{group.entries.filter(entry => entry.defeated).length}<span> / {group.entries.length}</span></span><Chevron className={`disclosure-chevron${expanded ? '' : ' collapsed'}`}/>
        </button>
        {expanded && <div className="area-encounters">{group.visible.map(entry => <label className={`encounter ${entry.defeated ? 'defeated' : ''} ${!editable ? 'locked' : ''}`} key={entry.id}>
          <input type="checkbox" checked={entry.defeated} disabled={!editable || busy} onChange={() => onToggle?.(entry)}/>
          <span className="encounter-checkbox">{entry.defeated ? '✓' : ''}</span><span className="encounter-copy"><strong>{entry.name}</strong><span>{entry.description}</span></span><span className={`encounter-kind ${entry.kind}`}>{entry.kind === 'boss' ? 'Boss' : 'Miniboss'}</span><span className="encounter-points">+{entry.points}</span>
        </label>)}</div>}
      </section>
    })}{!filtered.length && <div className="empty-panel"><h3>No encounters found.</h3><p>Try another search or turn off “Remaining only”.</p></div>}</div>
  </>
}
