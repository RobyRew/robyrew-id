// Production entry (Dockerfile CMD). Wraps the @astrojs/node standalone handler so
// every response gets the shared security headers from @robyrew/web-config. Script
// and style sources come from Astro's per-page <meta> CSP (security.csp); the
// header adds what a meta tag cannot carry (frame-ancestors).
//
// Boot order: autostart must be disabled before entry.mjs is imported, hence the
// dynamic import.
import http from 'node:http';
import { securityHeaders } from '@robyrew/web-config/security-headers';

process.env.ASTRO_NODE_AUTOSTART = 'disabled';
const { handler } = await import('./dist/server/entry.mjs');

const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || '0.0.0.0';
const headers = Object.entries(securityHeaders());

const server = http.createServer((req, res) => {
  for (const [key, value] of headers) res.setHeader(key, value);
  handler(req, res);
});
// A socket with no traffic for a minute is closed.
server.timeout = 60_000;

server.listen(PORT, HOST, () => {
  console.log(`robyrew-id listening on http://${HOST}:${PORT}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
