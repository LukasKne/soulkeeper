export type Username = string
export type AdminUser = { username: Username; active: boolean; can_manage: boolean }
export type AttemptStatus = 'not_started' | 'active' | 'failed' | 'completed'
export type Competition = {
  id: number
  number: number
  name: string
  status: 'current' | 'archived'
  created_at: string
  archived_at: string | null
  max_points: number
}
export type Session = { user: null | { username: Username; can_manage: boolean }; csrf_token: string | null }
export type CompetitionList = { competitions: Competition[]; current_id: number }
export type Player = { username: Username; rank: number; attempt_status: AttemptStatus; points: number; bosses_defeated: number; minibosses_defeated: number }
export type Leaderboard = { competition: Competition; players: Player[]; max_points: number }
export type Encounter = { id: string; area_id: string; area_name: string; area_order: number; name: string; description: string; kind: 'boss' | 'miniboss'; points: number; defeated: boolean }
export type Attempt = { status: AttemptStatus; started_at: string; ended_at: string | null; points: number; bosses_defeated: number; minibosses_defeated: number }
export type AttemptView = { competition: Competition; attempt: Attempt | null; encounters: Encounter[] }
