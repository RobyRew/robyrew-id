import type { APIRoute } from 'astro'

// Liveness only: independent of Logto and of any sign-in round trip.
export const GET: APIRoute = () => new Response('ok', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } })
