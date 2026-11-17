import { readFile } from 'node:fs/promises'
import type { APIRoute } from 'astro'
import { getApp } from '../../lib/app.ts'

// Public avatar files. Names are random and never reused (a new upload gets a new
// name), so a year of immutable caching is safe. Any app may embed them.
export const GET: APIRoute = async ({ params }) => {
  const path = getApp().avatarStore.pathOf(String(params.file ?? ''))
  if (!path) return new Response('Not found', { status: 404 })
  let body: Buffer
  try {
    body = await readFile(path)
  } catch {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'public, max-age=60' } })
  }
  return new Response(new Uint8Array(body), {
    headers: {
      'content-type': 'image/webp',
      'content-length': String(body.byteLength),
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'cross-origin',
    },
  })
}
