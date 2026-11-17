// @ts-check
import { createHash } from 'node:crypto';
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';
import { houseDefaults } from '@robyrew/web-config/astro';
import { themeBootstrap } from '@robyrew/web-config/theme-bootstrap';

const site = process.env.PUBLIC_SITE_URL || 'https://id.robyrew.com';
const logto = process.env.LOGTO_ENDPOINT || 'https://auth.robyrew.com';

// The pre-paint theme stamp is an inline script; its hash is computed here from
// the package's own string, so a web-config upgrade cannot leave a stale pin.
/** @type {`sha256-${string}`} */
const bootstrapHash = `sha256-${createHash('sha256').update(themeBootstrap).digest('base64')}`;

export default defineConfig({
  ...houseDefaults,
  site,
  output: 'server',
  // A little above the largest upload the avatar route accepts (10 MiB), so the
  // route's own check answers 413 first. The default is 1 GiB.
  adapter: node({ mode: 'standalone', bodySizeLimit: 11 * 1024 * 1024 }),

  security: {
    // CSRF: cross-origin form posts are refused. JSON routes also require a JSON
    // content type, which a cross-site form cannot send.
    checkOrigin: true,
    // Trust Host / X-Forwarded-Proto from Traefik for the public host only.
    allowedDomains: [{ protocol: new URL(site).protocol.replace(':', ''), hostname: new URL(site).hostname }],
    csp: {
      directives: [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        // Sign-out is a form POST answered with a 303 to Logto's end_session.
        `form-action 'self' ${new URL(logto).origin}`,
      ],
      scriptDirective: { hashes: [bootstrapHash] },
    },
  },

  server: { port: 4345 },
  // No Markdown here; Shiki's inline styles would also clash with the CSP.
  markdown: { syntaxHighlight: false },

  vite: {
    plugins: [tailwindcss()],
    // The local SQLite file and avatars change on every write; they are not source.
    server: { watch: { ignored: ['**/data/**'] } },
    build: { target: 'safari16', cssTarget: 'safari16' },
  },
});
