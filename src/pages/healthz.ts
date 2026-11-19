import type { APIRoute } from 'astro'

// For the VPS site probe (infrastructure: dokploy_site_probe_sites), which asks
// every probed host for /healthz and expects 200 with the body "ok". Same
// answer as /api/health; neither calls Logto.
export const GET: APIRoute = () => new Response('ok', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } })
