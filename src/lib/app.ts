import { join } from 'node:path'
import { createLogtoAuth } from '@robyrew/astro-logto'
import { sqliteSessionStore, type SqliteLike } from '@robyrew/astro-logto/sqlite'
import { createLogtoWebhookHandler } from '@robyrew/astro-logto/webhook'
import { createAvatarService, createAvatarStore } from './avatars.ts'
import { openDb } from './db.ts'
import { readEnv, type Env } from './env.ts'
import { createHandleService } from './handles.ts'
import { createManagementClient, toUser, type ManagementClient } from './management.ts'
import { createRateLimiter } from './ratelimit.ts'

/** What the session resolves to; everything else is read from the mirror. */
export interface SessionUser {
  id: string
}

const SYNC_EVERY_MS = 6 * 3_600_000

export interface AppOptions {
  /** Test seam: a Management API client instead of the real one. */
  management?: ManagementClient
  /** Mirror all Logto users at start and every 6 hours. Default true. */
  backgroundSync?: boolean
  logger?: Pick<Console, 'log' | 'warn' | 'error'>
}

export function createApp(env: Env, options: AppOptions = {}) {
  const log = options.logger ?? console
  const db = openDb(join(env.dataDir, 'robyrew-id.db'))
  const auth = createLogtoAuth<SessionUser>({
    endpoint: env.logtoEndpoint,
    appId: env.appId,
    appSecret: env.appSecret,
    publicOrigin: env.siteUrl,
    cookieName: 'rid_sid',
    sessionSecret: env.cookieSecret,
    store: sqliteSessionStore(db as unknown as SqliteLike, { createTable: true }),
    resolveUser: (claims) => ({ id: claims.sub }),
    logger: log,
  })
  const management =
    options.management ??
    createManagementClient({
      endpoint: env.logtoEndpoint,
      appId: env.m2mAppId,
      appSecret: env.m2mAppSecret,
      resource: env.managementResource,
    })
  const handles = createHandleService({ db, management, logger: log })
  const avatarStore = createAvatarStore({ dir: join(env.dataDir, 'avatars'), publicOrigin: env.siteUrl })
  const avatars = createAvatarService({ store: avatarStore, management, handles, logger: log })

  // Logto → mirror. The payload carries the whole user entity for updates; for
  // the rest the user is read again, and a deleted one is forgotten (which
  // releases the handles it held).
  const webhook = createLogtoWebhookHandler({
    signingKey: env.webhookSigningKey,
    revokeUser: auth.revokeUser,
    onUserDataUpdated: (user) => handles.mirror(toUser(user)),
    onUserDeleted: (id) => handles.forget(id),
    onUserSuspensionUpdated: async (id) => {
      await handles.syncUser(id)
    },
    onOtherEvent: async (event) => {
      const id = (event.data as { id?: unknown } | null)?.id
      if (event.event === 'User.Created' && typeof id === 'string') handles.mirror(toUser(event.data))
    },
    logger: log,
  })

  const limits = {
    // Availability checks while typing, and writes.
    check: createRateLimiter({ capacity: 60, refillEveryMs: 1_000 }),
    rename: createRateLimiter({ capacity: 10, refillEveryMs: 6 * 60_000 }),
    avatar: createRateLimiter({ capacity: 10, refillEveryMs: 6 * 60_000 }),
  }

  async function syncNow(): Promise<void> {
    try {
      const count = await handles.syncAll()
      const swept = await avatarStore.sweep(handles.avatarsInUse())
      log.log(`[sync] mirrored ${count} Logto users${swept ? `, removed ${swept} unused avatar files` : ''}`)
    } catch (err) {
      log.warn('[sync] mirroring Logto users failed:', err instanceof Error ? err.message : String(err))
    }
  }
  if (options.backgroundSync !== false) {
    void syncNow()
    setInterval(() => void syncNow(), SYNC_EVERY_MS).unref()
  }

  return { env, db, auth, management, handles, avatarStore, avatars, webhook, limits, syncNow }
}

export type App = ReturnType<typeof createApp>

let current: App | null = null

/** The process-wide app, created on first use (so `astro build` needs no env). */
export function getApp(): App {
  current ??= createApp(readEnv())
  return current
}
