import type { APIRoute } from 'astro'
import { getApp } from '../../lib/app.ts'
import { AvatarError, UPLOAD_MAX_BYTES } from '../../lib/avatars.ts'
import { backTo, json } from '../../lib/http.ts'

// POST /api/avatar  multipart/form-data: avatar=<file>  → upload (converted to WebP)
//                   multipart/form-data: remove=1       → remove
// Page scripts send the same form with fetch and Accept: application/json.

export const POST: APIRoute = async ({ request }) => {
  const app = getApp()
  const asJson = (request.headers.get('accept') ?? '').includes('application/json')
  const done = (code: string) => (asJson ? json({ ok: true, result: code }) : backTo('/', { saved: code }))
  const fail = (status: number, code: string) => (asJson ? json({ error: code }, status) : backTo('/', { error: code }))

  const session = await app.auth.getSession(request)
  if (!session) return fail(401, 'signed_out')
  if (!app.limits.avatar.take(session.sub)) return fail(429, 'rate_limited')

  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > UPLOAD_MAX_BYTES + 64 * 1024) return fail(413, 'too_large')

  const form = await request.formData().catch(() => null)
  if (!form) return fail(400, 'empty')
  try {
    if (form.get('remove') === '1') {
      await app.avatars.remove(session.sub)
      return done('avatar_removed')
    }
    const file = form.get('avatar')
    if (!(file instanceof File) || file.size === 0) return fail(400, 'empty')
    if (file.size > UPLOAD_MAX_BYTES) return fail(413, 'too_large')
    const url = await app.avatars.set(session.sub, new Uint8Array(await file.arrayBuffer()))
    return asJson ? json({ ok: true, avatar: url }) : backTo('/', { saved: 'avatar' })
  } catch (err) {
    if (err instanceof AvatarError) return fail(err.status, err.code)
    throw err
  }
}
