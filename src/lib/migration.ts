import { isHandle } from '@robyrew/astro-logto/handle'
import { CUSTOM_DATA_KEY, MAX_PREVIOUS_HANDLES, readHandleState } from './handles.ts'
import type { LogtoUser, UserPatch } from './management.ts'

// The one-off move of each app's own handles into Logto (scripts/migrate-handles.ts).
// A plan names, per Logto user, the username to hold and the old handles to keep
// reserved for them. It is an admin write: reserved words are allowed (they only
// stop self-service picks), the cooldown is not started (handleChangedAt is left
// alone), and the rule itself still applies.

export interface PlanEntry {
  /** Logto user id (sub). */
  id: string
  /** The username to hold; omitted = keep the current one. */
  username?: string
  /** Old handles to reserve for this user (customData.robyrewId.previousHandles). */
  reserve?: string[]
}

export type PlanStep =
  | { id: string; kind: 'unchanged' }
  | { id: string; kind: 'patch'; patch: UserPatch; changes: string[] }
  | { id: string; kind: 'error'; error: string }

export function planStep(user: LogtoUser, entry: PlanEntry): PlanStep {
  if (entry.username !== undefined && !isHandle(entry.username)) {
    return { id: user.id, kind: 'error', error: `"${entry.username}" breaks the handle rule` }
  }
  const badReserve = (entry.reserve ?? []).filter((h) => !isHandle(h))
  if (badReserve.length) return { id: user.id, kind: 'error', error: `cannot reserve ${badReserve.join(', ')}: not handles` }

  const target = entry.username ?? user.username
  const state = readHandleState(user.customData)
  const previous = [...new Set([...(entry.reserve ?? []), ...state.previousHandles])]
    .filter((h) => h !== target)
    .slice(0, MAX_PREVIOUS_HANDLES)

  const changes: string[] = []
  const patch: UserPatch = {}
  if (entry.username !== undefined && entry.username !== user.username) {
    patch.username = entry.username
    changes.push(`username ${user.username ?? '(none)'} → ${entry.username}`)
  }
  if (previous.join(',') !== state.previousHandles.join(',')) {
    const ours = (user.customData[CUSTOM_DATA_KEY] as Record<string, unknown> | undefined) ?? {}
    // Logto replaces customData as a whole on PATCH /api/users/:id, so the rest is sent back.
    patch.customData = { ...user.customData, [CUSTOM_DATA_KEY]: { ...ours, previousHandles: previous } }
    changes.push(`reserved [${state.previousHandles.join(', ')}] → [${previous.join(', ')}]`)
  }
  return changes.length ? { id: user.id, kind: 'patch', patch, changes } : { id: user.id, kind: 'unchanged' }
}
