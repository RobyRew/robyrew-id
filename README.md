# RobyRew ID

`id.robyrew.com` — where a person picks the one **@handle** and the one
**picture** they use across the RobyRew apps (MapSwitch, ChatForge, the
Spotify versions archive).

Both live in Logto, the identity provider every app already signs in with:
the handle is the Logto `username`, the picture is the Logto `avatar`. This
app is the only place they are written, through the Logto Management API.
Every app reads them from its ID token (`username`, `picture`, scope
`profile`) and keeps them current with a Logto webhook.

## What it does

- **Handle picker and rename.** The rule is the shared one in
  `@robyrew/astro-logto/handle`: `^[a-z_][a-z0-9_]{2,19}$`, minus a reserved
  list (every app's top-level routes, staff and brand words). One change
  every 30 days; the first pick is free and starts the clock. Earlier handles
  stay reserved for their owner in the Logto user's
  `customData.robyrewId.previousHandles` (newest first, the last 10); the owner
  can take one back, nobody else can.
- **Picture upload.** PNG, JPEG, WebP, AVIF or GIF up to 10 MB in; one
  512×512 WebP of at most 256 KB out, re-encoded by sharp (EXIF/XMP, GPS
  included, are dropped). Files live on this app's data volume and are served
  publicly at `/avatars/<random>.webp`; the URL becomes the Logto `avatar`.
- **Directory.** `/@handle` shows the handle, the name and the picture, and
  nothing else. An old handle redirects to the current one; pages carry
  `noindex`, and there is no listing of all users.

## How it fits together

```
browser ── id.robyrew.com ──(Management API, M2M)──▶ Logto user: username, avatar, customData
                │                                         │
                │◀──── webhook (User.Data.Updated…) ──────┤
                                                          ├──▶ ChatForge / MapSwitch / Spotify archive:
                                                          │    ID token `username`, `picture`, `roles`
                                                          └──▶ their own webhooks
```

The local SQLite database (`DATA_DIR/robyrew-id.db`, Node's built-in
`node:sqlite`) holds the sign-in sessions (sealed by `@robyrew/astro-logto`)
and a mirror of the Logto users for the directory and the availability check.
Logto stays the source of truth: the mirror is rebuilt at start, every six
hours, and on each webhook.

## Run it locally

No Logto needed: `dev:local` starts a fake Logto (from
`@robyrew/astro-logto/testing`) with three users and runs the dev server
against it.

```bash
npm install
npm run dev:local     # http://localhost:4345, fake Logto on :4346
```

Sign in by picking a user on the fake's page: `alice` (has a handle), `Bob`
(a Logto username that breaks the rule) or Carol (no username yet).

```bash
npm test              # handle rules, cooldown, reservations, avatars, routes against the fake Logto
npm run build         # tsc + Astro's checker + production build
```

## Configuration

See `.env.example`. Logto settings (applications, roles, webhooks, account
center, sign-up) are in [docs/logto-checklist.md](docs/logto-checklist.md);
deployment in [docs/deploy.md](docs/deploy.md).

## License

Apache-2.0
