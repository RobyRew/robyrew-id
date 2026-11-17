import { describe, expect, it } from 'vitest'
import { planStep } from '../src/lib/migration.ts'
import type { LogtoUser } from '../src/lib/management.ts'

const user = (over: Partial<LogtoUser> = {}): LogtoUser => ({ id: 'u1', username: 'robyrew', name: null, avatar: null, customData: {}, isSuspended: false, ...over })

describe('planStep', () => {
  it('reserves an old app handle without touching the username or the cooldown', () => {
    const step = planStep(user({ customData: { other: 1 } }), { id: 'u1', reserve: ['robyrew2'] })
    expect(step).toEqual({
      id: 'u1',
      kind: 'patch',
      patch: { customData: { other: 1, robyrewId: { previousHandles: ['robyrew2'] } } },
      changes: ['reserved [] → [robyrew2]'],
    })
  })

  it('sets a username, including a reserved word (admin write)', () => {
    const step = planStep(user({ username: 'RobyRew' }), { id: 'u1', username: 'robyrew' })
    expect(step).toMatchObject({ kind: 'patch', patch: { username: 'robyrew' } })
  })

  it('does nothing when Logto already matches', () => {
    expect(planStep(user({ customData: { robyrewId: { previousHandles: ['robyrew2'] } } }), { id: 'u1', username: 'robyrew', reserve: ['robyrew2'] })).toEqual({ id: 'u1', kind: 'unchanged' })
  })

  it('refuses a username or reservation that breaks the rule', () => {
    expect(planStep(user(), { id: 'u1', username: 'Rob-Yrew' })).toMatchObject({ kind: 'error' })
    expect(planStep(user(), { id: 'u1', reserve: ['my-name'] })).toMatchObject({ kind: 'error' })
  })

  it('never reserves the handle the user is about to hold', () => {
    const step = planStep(user({ username: 'robyrew2' }), { id: 'u1', username: 'robyrew', reserve: ['robyrew', 'robyrew2'] })
    expect(step).toMatchObject({ kind: 'patch', patch: { username: 'robyrew', customData: { robyrewId: { previousHandles: ['robyrew2'] } } } })
  })
})
