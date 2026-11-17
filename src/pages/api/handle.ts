import type { APIRoute } from 'astro'
import { getApp } from '../../lib/app.ts'
import { backTo, isJson, json } from '../../lib/http.ts'

// GET  /api/handle?check=<handle> → { handle, available, problem?, yours? } (live hint while typing)
// POST /api/handle  { handle }    → rename (JSON from the page, or a plain form post)

export const GET: APIRoute = async ({ request, url }) => {
  const app = getApp()
  const session = await app.auth.getSession(request)
  if (!session) return json({ error: 'unauthorized' }, 401)
  if (!app.limits.check.take(session.sub)) return json({ error: 'rate_limited' }, 429)
  const check = (url.searchParams.get('check') ?? '').slice(0, 64)
  return json(app.handles.availability(check, session.sub))
}

export const POST: APIRoute = async ({ request }) => {
  const app = getApp()
  const asJson = isJson(request)
  const fail = (status: number, code: string, extra: Record<string, unknown> = {}) =>
    asJson ? json({ error: code, ...extra }, status) : backTo('/', { error: code })

  const session = await app.auth.getSession(request)
  if (!session) return fail(401, 'signed_out')
  if (!app.limits.rename.take(session.sub)) return fail(429, 'rate_limited')

  let raw = ''
  if (asJson) {
    const body = (await request.json().catch(() => null)) as { handle?: unknown } | null
    raw = typeof body?.handle === 'string' ? body.handle : ''
  } else {
    const form = await request.formData().catch(() => null)
    const value = form?.get('handle')
    raw = typeof value === 'string' ? value : ''
  }

  const result = await app.handles.rename(session.sub, raw.slice(0, 64))
  if (!result.ok) {
    return fail(result.status, result.problem, result.nextChangeAt ? { nextChangeAt: new Date(result.nextChangeAt).toISOString() } : {})
  }
  const nextChangeAt = result.nextChangeAt ? new Date(result.nextChangeAt).toISOString() : null
  return asJson ? json({ handle: result.handle, changed: result.changed, nextChangeAt }) : backTo('/', { saved: 'handle' })
}
