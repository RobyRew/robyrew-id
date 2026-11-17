import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import type { APIContext } from 'astro'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFakeLogto, type FakeLogto } from '@robyrew/astro-logto/testing'

// The real route modules, run against a fake Logto: sign-in → callback → rename
// → avatar → webhook → directory, through the same getApp() the server uses.

const SITE = 'http://id.example.test'
let logto: FakeLogto
let dataDir: string
let routes: {
  signIn: typeof import('../src/pages/api/auth/sign-in.ts')
  callback: typeof import('../src/pages/api/auth/callback.ts')
  signOut: typeof import('../src/pages/api/auth/sign-out.ts')
  handle: typeof import('../src/pages/api/handle.ts')
  avatar: typeof import('../src/pages/api/avatar.ts')
  hook: typeof import('../src/pages/api/hooks/logto.ts')
  file: typeof import('../src/pages/avatars/[file].ts')
  app: typeof import('../src/lib/app.ts')
}

const jar: Record<string, string> = {}
const cookieHeader = () =>
  Object.entries(jar)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('; ')

function ctx(path: string, init: RequestInit & { params?: Record<string, string> } = {}): APIContext {
  const url = new URL(path, SITE)
  const headers = new Headers(init.headers)
  if (!headers.has('cookie') && Object.keys(jar).length) headers.set('cookie', cookieHeader())
  const request = new Request(url, { ...init, headers })
  const context = {
    url,
    request,
    params: init.params ?? {},
    cookies: {
      get: (name: string) => (name in jar ? { value: jar[name]! } : undefined),
      set: (name: string, value: string, options: { maxAge?: number }) => {
        if (options.maxAge === 0) delete jar[name]
        else jar[name] = value
      },
    },
    redirect: (location: string, status = 302) => new Response(null, { status, headers: { location } }),
  }
  return context as unknown as APIContext
}

async function call(route: { [method: string]: unknown }, method: string, context: APIContext): Promise<Response> {
  const handler = (route[method] ?? route.ALL) as (c: APIContext) => Response | Promise<Response>
  return handler(context)
}

beforeAll(async () => {
  logto = await startFakeLogto({
    apps: { 'rid-app': 'rid-secret' },
    m2mApps: { 'rid-m2m': 'm2m-secret' },
    users: [
      { id: 'alice0000001', username: null, name: 'Alice' },
      { id: 'bobby0000002', username: 'bob', name: 'Bob' },
    ],
  })
  dataDir = await mkdtemp(join(tmpdir(), 'rid-routes-'))
  Object.assign(process.env, {
    PUBLIC_SITE_URL: SITE,
    LOGTO_ENDPOINT: logto.endpoint,
    LOGTO_APP_ID: 'rid-app',
    LOGTO_APP_SECRET: 'rid-secret',
    LOGTO_COOKIE_SECRET: 'routes-test-cookie-secret-0123456789',
    LOGTO_M2M_APP_ID: 'rid-m2m',
    LOGTO_M2M_APP_SECRET: 'm2m-secret',
    LOGTO_WEBHOOK_SIGNING_KEY: 'hook-key',
    DATA_DIR: dataDir,
  })
  routes = {
    signIn: await import('../src/pages/api/auth/sign-in.ts'),
    callback: await import('../src/pages/api/auth/callback.ts'),
    signOut: await import('../src/pages/api/auth/sign-out.ts'),
    handle: await import('../src/pages/api/handle.ts'),
    avatar: await import('../src/pages/api/avatar.ts'),
    hook: await import('../src/pages/api/hooks/logto.ts'),
    file: await import('../src/pages/avatars/[file].ts'),
    app: await import('../src/lib/app.ts'),
  }
  await routes.app.getApp().syncNow()
})

afterAll(async () => {
  await logto.close()
  await rm(dataDir, { recursive: true, force: true })
})

describe('robyrew-id routes', () => {
  it('signs in as Alice through Logto', async () => {
    const start = await call(routes.signIn, 'GET', ctx('/api/auth/sign-in?returnTo=/'))
    const back = logto.authorize(start.headers.get('location')!, 'alice0000001')
    const done = await call(routes.callback, 'GET', ctx(back))
    expect(done.headers.get('location')).toBe('/')
    expect(Object.keys(jar)).toContain('rid_sid')
  })

  it('checks availability and saves a handle from JSON', async () => {
    const check = await call(routes.handle, 'GET', ctx('/api/handle?check=bob'))
    expect(await check.json()).toMatchObject({ handle: 'bob', available: false, problem: 'taken' })
    const res = await call(routes.handle, 'POST', ctx('/api/handle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'Alice' }) }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ handle: 'alice', changed: true })
    expect(logto.users.get('alice0000001')!.username).toBe('alice')
  })

  it('answers a form post with a redirect carrying the outcome', async () => {
    const res = await call(routes.handle, 'POST', ctx('/api/handle', { method: 'POST', body: new URLSearchParams({ handle: 'alice_2' }) }))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/?error=cooldown')
  })

  it('refuses writes without a session', async () => {
    const saved = { ...jar }
    for (const k of Object.keys(jar)) delete jar[k]
    const res = await call(routes.handle, 'POST', ctx('/api/handle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"handle":"zed"}' }))
    expect(res.status).toBe(401)
    Object.assign(jar, saved)
  })

  it('uploads a picture, serves it publicly and sets it as the Logto avatar', async () => {
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#3366ff' } }).png().toBuffer()
    const form = new FormData()
    form.set('avatar', new File([new Uint8Array(png)], 'me.png', { type: 'image/png' }))
    const res = await call(routes.avatar, 'POST', ctx('/api/avatar', { method: 'POST', body: form, headers: { accept: 'application/json' } }))
    expect(res.status).toBe(200)
    const { avatar } = (await res.json()) as { avatar: string }
    expect(logto.users.get('alice0000001')!.avatar).toBe(avatar)
    const file = avatar.split('/').pop()!
    const served = await call(routes.file, 'GET', ctx(`/avatars/${file}`, { params: { file } }))
    expect(served.headers.get('content-type')).toBe('image/webp')
    expect(served.headers.get('cache-control')).toContain('immutable')
    expect((await sharp(Buffer.from(await served.arrayBuffer())).metadata()).width).toBe(512)
    expect((await call(routes.file, 'GET', ctx('/avatars/x', { params: { file: '../robyrew-id.db' } }))).status).toBe(404)
  })

  it('mirrors a signed Logto webhook and refuses an unsigned one', async () => {
    const body = JSON.stringify({
      event: 'User.Data.Updated',
      deliveryId: 'd-1',
      createdAt: new Date().toISOString(),
      data: { id: 'bobby0000002', username: 'bob', name: 'Robert', avatar: null, customData: {}, isSuspended: false },
    })
    const sign = (key: string) => createHmac('sha256', key).update(body).digest('hex')
    const bad = await call(routes.hook, 'POST', ctx('/api/hooks/logto', { method: 'POST', body, headers: { 'content-type': 'application/json', 'logto-signature-sha-256': sign('wrong') } }))
    expect(bad.status).toBe(401)
    const good = await call(routes.hook, 'POST', ctx('/api/hooks/logto', { method: 'POST', body, headers: { 'content-type': 'application/json', 'logto-signature-sha-256': sign('hook-key') } }))
    expect(good.status).toBe(200)
    expect(routes.app.getApp().handles.lookup('bob')).toEqual({ kind: 'profile', handle: 'bob', name: 'Robert', avatar: null })
  })

  it('signs out with a same-origin POST only', async () => {
    expect((await call(routes.signOut, 'GET', ctx('/api/auth/sign-out'))).status).toBe(405)
    const res = await call(routes.signOut, 'POST', ctx('/api/auth/sign-out', { method: 'POST', headers: { origin: SITE } }))
    expect(res.status).toBe(303)
    expect(jar.rid_sid).toBeUndefined()
  })
})
