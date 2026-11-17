import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakeLogto, type FakeLogto } from '@robyrew/astro-logto/testing'
import { AVATAR_MAX_BYTES, AvatarError, createAvatarService, createAvatarStore, toAvatarWebp } from '../src/lib/avatars.ts'
import { openDb } from '../src/lib/db.ts'
import { createHandleService } from '../src/lib/handles.ts'
import { createManagementClient } from '../src/lib/management.ts'

const ORIGIN = 'https://id.example.test'
const quiet = { warn: () => {}, error: () => {} }

async function image(width: number, height: number, format: 'png' | 'jpeg' = 'png', noise = false) {
  const base = noise
    ? sharp(Buffer.from(Array.from({ length: width * height * 3 }, () => Math.floor(Math.random() * 256))), { raw: { width, height, channels: 3 } })
    : sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } })
  return format === 'jpeg'
    ? base.jpeg().withExif({ IFD0: { Copyright: 'secret-place', ImageDescription: 'GPS here' } }).toBuffer()
    : base.png().toBuffer()
}

describe('toAvatarWebp', () => {
  it('makes a 512×512 WebP under 256 KB without the source metadata', async () => {
    const out = await toAvatarWebp(await image(1200, 800, 'jpeg'))
    const meta = await sharp(out).metadata()
    expect(meta).toMatchObject({ format: 'webp', width: 512, height: 512 })
    expect(meta.exif).toBeUndefined()
    expect(out.byteLength).toBeLessThanOrEqual(AVATAR_MAX_BYTES)
  })

  it('fits even a noisy photo under 256 KB', async () => {
    const out = await toAvatarWebp(await image(1600, 1600, 'png', true))
    expect(out.byteLength).toBeLessThanOrEqual(AVATAR_MAX_BYTES)
  })

  it('refuses what is not a usable image', async () => {
    await expect(toAvatarWebp(new TextEncoder().encode('<svg onload=alert(1)>'))).rejects.toMatchObject({ status: 415 })
    await expect(toAvatarWebp(new Uint8Array())).rejects.toMatchObject({ status: 400, code: 'empty' })
    await expect(toAvatarWebp(await image(20, 20))).rejects.toMatchObject({ status: 422, code: 'too_small' })
  })
})

describe('avatar service', () => {
  let logto: FakeLogto
  let dir: string

  beforeEach(async () => {
    logto = await startFakeLogto({ users: [{ id: 'alice0000001', username: 'alice', avatar: 'https://lh3.example.test/google.jpg' }] })
    dir = await mkdtemp(join(tmpdir(), 'rid-avatars-'))
  })
  afterEach(async () => {
    await logto.close()
    await rm(dir, { recursive: true, force: true })
  })

  function setup(management = createManagementClient({ endpoint: logto.endpoint, appId: 'm2m-id', appSecret: 'm2m-secret' })) {
    const handles = createHandleService({ db: openDb(':memory:'), management, logger: quiet })
    const store = createAvatarStore({ dir, publicOrigin: ORIGIN })
    return { store, handles, avatars: createAvatarService({ store, management, handles, logger: quiet }) }
  }

  it('stores the WebP, writes its URL to Logto and deletes only its own previous file', async () => {
    const { avatars, handles } = setup()
    const first = await avatars.set('alice0000001', await image(600, 600))
    expect(first).toMatch(/^https:\/\/id\.example\.test\/avatars\/[\w-]{22}\.webp$/)
    expect(logto.users.get('alice0000001')!.avatar).toBe(first)
    expect(handles.account('alice0000001')?.avatar).toBe(first)
    expect(await readdir(dir)).toHaveLength(1)
    const second = await avatars.set('alice0000001', await image(700, 700))
    expect(second).not.toBe(first)
    expect(await readdir(dir)).toEqual([second.split('/').pop()])
    await avatars.remove('alice0000001')
    expect(logto.users.get('alice0000001')!.avatar).toBeNull()
    expect(await readdir(dir)).toEqual([])
  })

  it('removes the new file when Logto refuses the write', async () => {
    const real = createManagementClient({ endpoint: logto.endpoint, appId: 'm2m-id', appSecret: 'm2m-secret' })
    const { avatars } = setup({ ...real, patchUser: async () => Promise.reject(new Error('down')) })
    await expect(avatars.set('alice0000001', await image(600, 600))).rejects.toBeInstanceOf(AvatarError)
    expect(await readdir(dir)).toEqual([])
    expect(logto.users.get('alice0000001')!.avatar).toBe('https://lh3.example.test/google.jpg')
  })

  it('sweeps old files nothing points at', async () => {
    const { store } = setup()
    const kept = await store.save(Buffer.from('a'))
    const orphan = await store.save(Buffer.from('b'))
    const old = new Date(Date.now() - 2 * 86_400_000)
    await utimes(join(dir, orphan.file), old, old)
    expect(await store.sweep(new Set([kept.url]))).toBe(1)
    expect(await readdir(dir)).toEqual([kept.file])
    expect(store.pathOf('../../etc/passwd')).toBeNull()
  })
})
