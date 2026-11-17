import { HANDLE_PATTERN, checkHandle, isHandle, normalizeHandle, type HandleProblem } from '@robyrew/astro-logto/handle'
import { transaction, type Db } from './db.ts'
import { ManagementError, allUsers, type LogtoUser, type ManagementClient } from './management.ts'

// Handles: the Logto `username` is the handle. This service is the only writer.
//
// Rules enforced here, on top of the shared rule in @robyrew/astro-logto/handle:
//   - 30-day cooldown between changes. The first pick is free; it starts the clock.
//   - The handles a person had before stay reserved for them (customData, newest
//     first, at most MAX_PREVIOUS_HANDLES; older ones are released). They may take
//     one back; nobody else may take it.
//   - Logto's own unique index on username is the last guard against a race.

export const COOLDOWN_MS = 30 * 86_400_000
export const MAX_PREVIOUS_HANDLES = 10
/** The key robyrew-id owns inside each Logto user's customData. */
export const CUSTOM_DATA_KEY = 'robyrewId'

export interface HandleState {
  /** ISO time of the last change made here; null before the first one. */
  handleChangedAt: string | null
  /** Older handles, newest first, reserved for this person. */
  previousHandles: string[]
}

export function readHandleState(customData: Record<string, unknown>): HandleState {
  const raw = customData[CUSTOM_DATA_KEY] as { handleChangedAt?: unknown; previousHandles?: unknown } | undefined
  const changed = typeof raw?.handleChangedAt === 'string' && Number.isFinite(Date.parse(raw.handleChangedAt)) ? raw.handleChangedAt : null
  const previous = Array.isArray(raw?.previousHandles) ? raw.previousHandles.filter(isHandle) : []
  return { handleChangedAt: changed, previousHandles: [...new Set(previous)].slice(0, MAX_PREVIOUS_HANDLES) }
}

export type RenameProblem = HandleProblem | 'taken' | 'cooldown' | 'suspended' | 'not_found' | 'unavailable'

export type RenameResult =
  | { ok: true; handle: string; changed: boolean; nextChangeAt: number | null }
  | { ok: false; status: 400 | 403 | 404 | 409 | 429 | 503; problem: RenameProblem; nextChangeAt?: number }

export interface Availability {
  handle: string
  available: boolean
  problem?: HandleProblem | 'taken'
  /** The handle is one of the caller's own (current or reserved). */
  yours?: boolean
}

export type DirectoryEntry =
  | { kind: 'profile'; handle: string; name: string | null; avatar: string | null }
  | { kind: 'moved'; handle: string }

export interface AccountView {
  id: string
  username: string | null
  /** The username when it passes the rule, else null. */
  handle: string | null
  name: string | null
  avatar: string | null
  suspended: boolean
  previousHandles: string[]
  /** When the handle can change again; null when it can change now. */
  nextChangeAt: number | null
}

interface ProfileRow {
  id: string
  username: string | null
  name: string | null
  avatar: string | null
  suspended: number
  handle_changed_at: number | null
  previous_handles: string
}

export interface HandleServiceOptions {
  db: Db
  management: ManagementClient
  now?: () => number
  logger?: Pick<Console, 'warn' | 'error'>
}

/** A promise chain used as a mutex: one rename at a time in this process. */
function mutex() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn)
    tail = run.catch(() => undefined)
    return run
  }
}

export function createHandleService(options: HandleServiceOptions) {
  const { db, management } = options
  const now = options.now ?? Date.now
  const log = options.logger ?? console
  const serialize = mutex()

  const q = {
    upsertProfile: db.prepare(
      `INSERT INTO profiles (id, username, name, avatar, suspended, handle_changed_at, previous_handles, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET username = excluded.username, name = excluded.name, avatar = excluded.avatar,
         suspended = excluded.suspended, handle_changed_at = excluded.handle_changed_at,
         previous_handles = excluded.previous_handles, synced_at = excluded.synced_at`,
    ),
    deleteHandles: db.prepare('DELETE FROM handles WHERE profile_id = ?'),
    // A current username beats another person's stale reservation; between two
    // current usernames (case variants such as Bob/bob) the first one indexed stays.
    insertCurrent: db.prepare(
      `INSERT INTO handles (handle, profile_id, kind) VALUES (?, ?, 'current')
       ON CONFLICT(handle) DO UPDATE SET profile_id = excluded.profile_id, kind = 'current' WHERE handles.kind = 'previous'`,
    ),
    insertPrevious: db.prepare(`INSERT OR IGNORE INTO handles (handle, profile_id, kind) VALUES (?, ?, 'previous')`),
    deleteProfile: db.prepare('DELETE FROM profiles WHERE id = ?'),
    profile: db.prepare('SELECT * FROM profiles WHERE id = ?'),
    owner: db.prepare('SELECT profile_id AS id, kind FROM handles WHERE handle = ?'),
    lookup: db.prepare('SELECT h.kind AS kind, p.* FROM handles h JOIN profiles p ON p.id = h.profile_id WHERE h.handle = ?'),
    ids: db.prepare('SELECT id FROM profiles'),
    avatars: db.prepare('SELECT avatar FROM profiles WHERE avatar IS NOT NULL'),
  }

  /** Copies one Logto user into the local mirror and handle index. */
  function mirror(user: LogtoUser): void {
    const state = readHandleState(user.customData)
    const changedAt = state.handleChangedAt ? Date.parse(state.handleChangedAt) : null
    transaction(db, () => {
      q.upsertProfile.run(
        user.id,
        user.username,
        user.name,
        user.avatar,
        user.isSuspended ? 1 : 0,
        changedAt,
        JSON.stringify(state.previousHandles),
        now(),
      )
      q.deleteHandles.run(user.id)
      if (user.username) {
        const result = q.insertCurrent.run(user.username.toLowerCase(), user.id)
        if (Number(result.changes) === 0) log.warn(`[handles] ${user.id}: username ${user.username} is already indexed for another user`)
      }
      for (const handle of state.previousHandles) {
        if (handle !== user.username) q.insertPrevious.run(handle, user.id)
      }
    })
  }

  function forget(id: string): void {
    transaction(db, () => {
      q.deleteHandles.run(id)
      q.deleteProfile.run(id)
    })
  }

  async function syncUser(id: string): Promise<LogtoUser | null> {
    try {
      const user = await management.getUser(id)
      mirror(user)
      return user
    } catch (err) {
      if (err instanceof ManagementError && err.status === 404) {
        forget(id)
        return null
      }
      throw err
    }
  }

  /** Mirrors every Logto user and forgets the ones Logto no longer has. */
  async function syncAll(): Promise<number> {
    const seen = new Set<string>()
    for await (const user of allUsers(management)) {
      mirror(user)
      seen.add(user.id)
    }
    for (const { id } of q.ids.all() as Array<{ id: string }>) if (!seen.has(id)) forget(id)
    return seen.size
  }

  function nextChangeAt(row: Pick<ProfileRow, 'username' | 'handle_changed_at'> | null): number | null {
    if (!row || !isHandle(row.username) || row.handle_changed_at === null) return null
    const at = row.handle_changed_at + COOLDOWN_MS
    return at > now() ? at : null
  }

  function account(id: string): AccountView | null {
    const row = q.profile.get(id) as ProfileRow | undefined
    if (!row) return null
    return {
      id: row.id,
      username: row.username,
      handle: isHandle(row.username) ? row.username : null,
      name: row.name,
      avatar: row.avatar,
      suspended: row.suspended === 1,
      previousHandles: JSON.parse(row.previous_handles) as string[],
      nextChangeAt: nextChangeAt(row),
    }
  }

  function availability(raw: string, userId?: string): Availability {
    const check = checkHandle(raw)
    if (!check.ok) return { handle: check.handle, available: false, problem: check.problem }
    const owner = q.owner.get(check.handle) as { id: string; kind: string } | undefined
    if (owner && owner.id !== userId) return { handle: check.handle, available: false, problem: 'taken' }
    return { handle: check.handle, available: true, ...(owner ? { yours: true } : {}) }
  }

  async function rename(userId: string, raw: string): Promise<RenameResult> {
    const check = checkHandle(raw)
    if (!check.ok) return { ok: false, status: 400, problem: check.problem }
    const handle = check.handle
    return serialize(async () => {
      let user: LogtoUser
      try {
        user = await management.getUser(userId)
      } catch (err) {
        if (err instanceof ManagementError && err.status === 404) return { ok: false, status: 404, problem: 'not_found' }
        log.error('[handles] reading the Logto user failed:', err instanceof Error ? err.message : String(err))
        return { ok: false, status: 503, problem: 'unavailable' }
      }
      mirror(user)
      if (user.isSuspended) return { ok: false, status: 403, problem: 'suspended' }
      const state = readHandleState(user.customData)
      const current = isHandle(user.username) ? user.username : null
      const changedAt = state.handleChangedAt ? Date.parse(state.handleChangedAt) : null
      if (current === handle) {
        return { ok: true, handle, changed: false, nextChangeAt: nextChangeAt({ username: current, handle_changed_at: changedAt }) }
      }
      const next = nextChangeAt({ username: current, handle_changed_at: changedAt })
      if (next !== null) return { ok: false, status: 429, problem: 'cooldown', nextChangeAt: next }

      const owner = q.owner.get(handle) as { id: string } | undefined
      if (owner && owner.id !== userId) return { ok: false, status: 409, problem: 'taken' }

      const previousHandles = [...new Set([...(current ? [current] : []), ...state.previousHandles])]
        .filter((h) => h !== handle)
        .slice(0, MAX_PREVIOUS_HANDLES)
      const changed = new Date(now()).toISOString()
      const ours = (user.customData[CUSTOM_DATA_KEY] as Record<string, unknown> | undefined) ?? {}
      // One PATCH, so the new username and the reservation of the old one land
      // together. Logto replaces customData as a whole, so the rest of it is sent back.
      const customData = { ...user.customData, [CUSTOM_DATA_KEY]: { ...ours, handleChangedAt: changed, previousHandles } }
      let updated: LogtoUser
      try {
        updated = await management.patchUser(userId, { username: handle, customData })
      } catch (err) {
        if (err instanceof ManagementError && (err.status === 422 || err.code === 'user.username_already_in_use')) {
          return { ok: false, status: 409, problem: 'taken' }
        }
        log.error('[handles] writing the Logto user failed:', err instanceof Error ? err.message : String(err))
        return { ok: false, status: 503, problem: 'unavailable' }
      }
      mirror(updated)
      return { ok: true, handle, changed: true, nextChangeAt: Date.parse(changed) + COOLDOWN_MS }
    })
  }

  /** What /@handle shows: only handle, name and avatar; a reserved old handle points at the current one. */
  function lookup(raw: string): DirectoryEntry | null {
    const handle = normalizeHandle(raw)
    if (!HANDLE_PATTERN.test(handle)) return null
    const row = q.lookup.get(handle) as (ProfileRow & { kind: string }) | undefined
    if (!row || row.suspended === 1) return null
    if (row.kind === 'previous') return isHandle(row.username) ? { kind: 'moved', handle: row.username } : null
    // A Logto username that breaks the rule (e.g. "Bob") is indexed as "bob" for
    // availability, but it is not a handle, so it gets no page.
    if (row.username !== handle) return null
    return { kind: 'profile', handle, name: row.name, avatar: row.avatar }
  }

  function avatarsInUse(): Set<string> {
    return new Set((q.avatars.all() as Array<{ avatar: string }>).map((r) => r.avatar))
  }

  return { mirror, forget, syncUser, syncAll, account, availability, rename, lookup, avatarsInUse }
}

export type HandleService = ReturnType<typeof createHandleService>
