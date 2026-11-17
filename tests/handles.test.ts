import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakeLogto, type FakeLogto } from '@robyrew/astro-logto/testing'
import { openDb } from '../src/lib/db.ts'
import { COOLDOWN_MS, CUSTOM_DATA_KEY, MAX_PREVIOUS_HANDLES, createHandleService } from '../src/lib/handles.ts'
import { createManagementClient } from '../src/lib/management.ts'

const DAY = 86_400_000
const quiet = { warn: () => {}, error: () => {} }

let logto: FakeLogto
let clock: number

beforeEach(async () => {
  clock = Date.parse('2026-11-17T12:00:00Z')
  logto = await startFakeLogto({
    users: [
      { id: 'alice0000001', username: null, name: 'Alice', customData: { other: { keep: true } } },
      { id: 'bobby0000002', username: 'bob', name: 'Bob' },
      { id: 'caps00000003', username: 'Carol', name: 'Carol' },
    ],
  })
})
afterEach(async () => {
  await logto.close()
})

function service() {
  const db = openDb(':memory:')
  const management = createManagementClient({ endpoint: logto.endpoint, appId: 'm2m-id', appSecret: 'm2m-secret' })
  const handles = createHandleService({ db, management, now: () => clock, logger: quiet })
  return { db, handles }
}

const meta = (id: string) => logto.users.get(id)!.customData[CUSTOM_DATA_KEY] as { handleChangedAt: string; previousHandles: string[] }

describe('rename', () => {
  it('first pick writes the Logto username, keeps other customData and starts the cooldown', async () => {
    const { handles } = service()
    await handles.syncAll()
    const result = await handles.rename('alice0000001', '@Alice_1')
    expect(result).toEqual({ ok: true, handle: 'alice_1', changed: true, nextChangeAt: clock + COOLDOWN_MS })
    const user = logto.users.get('alice0000001')!
    expect(user.username).toBe('alice_1')
    expect(user.customData.other).toEqual({ keep: true })
    expect(meta('alice0000001')).toEqual({ handleChangedAt: new Date(clock).toISOString(), previousHandles: [] })
  })

  it('refuses a change inside 30 days, allows it after, and reserves the old handle', async () => {
    const { handles } = service()
    await handles.syncAll()
    await handles.rename('alice0000001', 'alice')
    clock += 29 * DAY
    expect(await handles.rename('alice0000001', 'alice_new')).toMatchObject({ ok: false, status: 429, problem: 'cooldown' })
    clock += 2 * DAY
    expect(await handles.rename('alice0000001', 'alice_new')).toMatchObject({ ok: true, handle: 'alice_new' })
    expect(meta('alice0000001').previousHandles).toEqual(['alice'])
    // Nobody else can take it…
    expect(await handles.rename('bobby0000002', 'alice')).toMatchObject({ ok: false, status: 409, problem: 'taken' })
    expect(handles.availability('alice', 'bobby0000002')).toMatchObject({ available: false, problem: 'taken' })
    // …but its owner can take it back after the next cooldown.
    expect(handles.availability('alice', 'alice0000001')).toMatchObject({ available: true, yours: true })
    clock += 31 * DAY
    expect(await handles.rename('alice0000001', 'alice')).toMatchObject({ ok: true })
    expect(meta('alice0000001').previousHandles).toEqual(['alice_new'])
  })

  it('lets a handle chosen elsewhere (migration, Logto sign-up) change once without waiting', async () => {
    const { handles } = service()
    await handles.syncAll()
    expect(await handles.rename('bobby0000002', 'bobby')).toMatchObject({ ok: true, handle: 'bobby' })
    expect(meta('bobby0000002').previousHandles).toEqual(['bob'])
  })

  it('refuses taken, reserved and malformed handles before calling Logto', async () => {
    const { handles } = service()
    await handles.syncAll()
    expect(await handles.rename('alice0000001', 'bob')).toMatchObject({ status: 409, problem: 'taken' })
    expect(await handles.rename('alice0000001', 'admin')).toMatchObject({ status: 400, problem: 'reserved' })
    expect(await handles.rename('alice0000001', '1abc')).toMatchObject({ status: 400, problem: 'bad_start' })
    expect(await handles.rename('alice0000001', 'a-b-c')).toMatchObject({ status: 400, problem: 'bad_chars' })
    // "Carol" (Logto's own sign-up form allows capitals) blocks "carol" for others…
    expect(await handles.rename('alice0000001', 'carol')).toMatchObject({ status: 409, problem: 'taken' })
    // …and is free for Carol herself.
    expect(await handles.rename('caps00000003', 'carol')).toMatchObject({ ok: true, handle: 'carol' })
  })

  it('maps a Logto unique-username refusal (stale mirror) to taken', async () => {
    const { handles } = service()
    await handles.syncAll()
    logto.addUser({ id: 'late00000004', username: 'latecomer' }) // not mirrored yet
    expect(await handles.rename('alice0000001', 'latecomer')).toMatchObject({ ok: false, status: 409, problem: 'taken' })
    expect(logto.users.get('alice0000001')!.username).toBeNull()
  })

  it('refuses a suspended user', async () => {
    const { handles } = service()
    logto.suspend('alice0000001')
    expect(await handles.rename('alice0000001', 'alice')).toMatchObject({ ok: false, status: 403, problem: 'suspended' })
  })

  it(`keeps at most ${MAX_PREVIOUS_HANDLES} reserved handles, newest first`, async () => {
    const { handles } = service()
    await handles.syncAll()
    for (let i = 0; i < MAX_PREVIOUS_HANDLES + 3; i++) {
      expect(await handles.rename('alice0000001', `alice_${i}`)).toMatchObject({ ok: true })
      clock += COOLDOWN_MS
    }
    const previous = meta('alice0000001').previousHandles
    expect(previous).toHaveLength(MAX_PREVIOUS_HANDLES)
    expect(previous[0]).toBe(`alice_${MAX_PREVIOUS_HANDLES + 1}`)
    expect(handles.availability('alice_0', 'bobby0000002').available).toBe(true)
  })
})

describe('directory and mirror', () => {
  it('shows handle, name and avatar; points old handles at the new one; hides the rest', async () => {
    const { handles } = service()
    await handles.syncAll()
    await handles.rename('alice0000001', 'alice')
    clock += COOLDOWN_MS
    await handles.rename('alice0000001', 'alice_two')
    expect(handles.lookup('alice_two')).toEqual({ kind: 'profile', handle: 'alice_two', name: 'Alice', avatar: null })
    expect(handles.lookup('ALICE')).toEqual({ kind: 'moved', handle: 'alice_two' })
    expect(handles.lookup('carol')).toBeNull() // Logto "Carol" is not a handle
    expect(handles.lookup('nobody')).toBeNull()
    expect(handles.lookup('../x')).toBeNull()
    logto.suspend('bobby0000002')
    await handles.syncUser('bobby0000002')
    expect(handles.lookup('bob')).toBeNull()
  })

  it('forgets users Logto no longer has, which releases their handles', async () => {
    const { handles } = service()
    await handles.syncAll()
    logto.users.delete('bobby0000002')
    expect(await handles.syncAll()).toBe(2)
    expect(handles.account('bobby0000002')).toBeNull()
    expect(handles.availability('bob', 'alice0000001').available).toBe(true)
  })

  it('reports the cooldown on the account view', async () => {
    const { handles } = service()
    await handles.syncAll()
    await handles.rename('alice0000001', 'alice')
    expect(handles.account('alice0000001')).toMatchObject({ handle: 'alice', nextChangeAt: clock + COOLDOWN_MS, previousHandles: [] })
    clock += COOLDOWN_MS
    expect(handles.account('alice0000001')?.nextChangeAt).toBeNull()
  })
})
