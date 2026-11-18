# Logto settings for RobyRew ID

What the Logto tenant needs so that the Logto `username` is the one @handle and
the Logto `avatar` the one picture across the apps. Apply in the Console
(tailnet-only) or through the
Management API with the machine-to-machine app from step 1. Logto 1.46.

The order matters: steps 1–7 can be applied before the handle migration;
step 8 only after it.

State read from the production Logto database on 2026-11-17: step 3 is
already in place (`enabledExtendedClaims` includes `roles`), and so is the
username part of step 8 (sign-up identifiers `["username"]`, every user has a
username). Steps 1, 2, 4, 5 and 7 are not done (no M2M app, no RobyRew ID app,
no `moderator` role, Account center off, no webhooks); step 6 has nothing to
check yet (no social connectors).

## 1. Machine-to-machine app for the Management API

- Console → Applications → Create → **Machine-to-machine**, name
  `RobyRew ID (management)`.
- Assign the role **Logto Management API access**.
- Store App ID and secret in the vault; they become robyrew-id's
  `LOGTO_M2M_APP_ID` / `LOGTO_M2M_APP_SECRET`, and the migration script uses
  the same pair.
- The Management API resource on a self-hosted Logto is
  `https://default.logto.app/api` (token: `POST /oidc/token`,
  `grant_type=client_credentials`, `resource=https://default.logto.app/api`,
  `scope=all`).

## 2. The RobyRew ID application

- Console → Applications → Create → **Traditional Web**, **first-party**
  (a third-party registration refuses `profile`/`email` and loops), name
  `RobyRew ID`.
- Redirect URI `https://id.robyrew.com/api/auth/callback`; post sign-out
  redirect URI `https://id.robyrew.com/`.
- App ID and secret → `LOGTO_APP_ID` / `LOGTO_APP_SECRET`.

## 3. `roles` in the ID token

Apps read roles from the ID token: `@robyrew/astro-logto` asks for the `roles`
scope, and Logto adds the claim only when the ID-token setting includes it.

- Console → **Custom JWT** → ID token claims: `roles` on.
- API: `GET /api/configs/id-token`, then `PUT /api/configs/id-token` with the
  same list plus `"roles"`:
  `{ "enabledExtendedClaims": ["roles", …whatever was there] }`. PUT replaces
  the list, so read it first.

## 4. Global role `moderator`

- Console → Roles → Create role, type **User**, name `moderator`,
  description "Can moderate content in every RobyRew app". No permissions are
  needed: the apps check the role name in the `roles` claim.
- API: `POST /api/roles`
  `{ "name": "moderator", "description": "Can moderate content in every RobyRew app", "type": "User" }`,
  then `POST /api/roles/{roleId}/users` `{ "userIds": ["…"] }` (or
  `POST /api/users/{userId}/roles` `{ "roleIds": ["…"] }`).

## 5. Account API (account center)

- Console → Sign-in & account → **Account center** → Enable Account API.
- Field permissions (`PATCH /api/account-center` with
  `{ "enabled": true, "fields": { … } }`):

  | Field | Value | Why |
  |---|---|---|
  | `username` | `ReadOnly` | `Edit` lets anyone change it with `PATCH /api/my-account`, past the handle rule, the 30-day cooldown and the reserved old handles. |
  | `avatar` | `ReadOnly` | Pictures go through id.robyrew.com (re-encoded, metadata stripped). |
  | `customData` | `Off` | Holds `robyrewId.previousHandles`; editing it would release or steal reservations. |
  | `name` | your call (`Edit` is safe) | No app treats the name as an identifier. |
  | the rest | your call | Email, password, MFA, passkeys, sessions are what the Account API is for. |

## 6. Social connectors: keep profile sync at registration only

Console → Connectors → Social connectors → each connector → **Sync user
profiles** = "sync only upon registration" (the default). "Sync at each
sign-in" overwrites the avatar and username with the provider's on every
Google/GitHub/… sign-in, undoing what was set at id.robyrew.com.

## 7. One webhook per app

Console → Webhooks → Create (or `POST /api/hooks`
`{ "name", "events": [...], "config": { "url" } }`; the response carries
`signingKey`). Put each signing key in that app's env as
`LOGTO_WEBHOOK_SIGNING_KEY`. Create a webhook only once its route is deployed:
Logto retries a 5xx three times, and a 404 is final.

| App | URL | Events |
|---|---|---|
| RobyRew ID | `https://id.robyrew.com/api/hooks/logto` | `User.Created`, `User.Data.Updated`, `User.Deleted`, `User.SuspensionStatus.Updated` |
| ChatForge | `https://chat.robyrew.com/api/hooks/logto` | `User.Data.Updated` |
| MapSwitch | `https://maps.robyrew.com/api/hooks/logto` | `User.Data.Updated` |
| Spotify versions | `https://spotify-versions-history.robyrew.com/api/hooks/logto` | `User.Data.Updated`, `User.Deleted`, `User.SuspensionStatus.Updated` |

## 8. Username required at sign-up — AFTER the migration

Console → Sign-in experience → Sign-up and sign-in → sign-up identifier
**Username** (with email as today). API: `PATCH /api/sign-in-exp`
`{ "signUp": { "identifiers": ["username", "email"], "password": true, "verify": true } }`
(read the current `signUp` first and keep its other values).

- New users then pick a username at sign-up, and existing users without one
  are asked for it at their next sign-in. Check that prompt with a test
  account: Logto's docs describe it for new registrations only.
- Turn it on only after the migration has written the existing ChatForge and
  MapSwitch handles into Logto. Before that, those users would be asked for a
  username at Logto and could pick one that differs from their app handle.
- Logto's own sign-up form accepts `^[A-Z_a-z]\w*$` (capitals, any length).
  Apps show a Logto username only when it passes the RobyRew rule
  `^[a-z_][a-z0-9_]{2,19}$`; anything else shows as `user-<6>` until the
  person picks a handle at id.robyrew.com, which offers a lowercase
  suggestion.
