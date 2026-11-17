// Logto Management API, called as the machine-to-machine app that holds the
// "Logto Management API access" role. robyrew-id writes the Logto user (username,
// avatar, customData) here; every app then reads the result from its ID token.

export interface LogtoUser {
  id: string
  username: string | null
  name: string | null
  avatar: string | null
  customData: Record<string, unknown>
  isSuspended: boolean
}

export interface UserPatch {
  username?: string
  avatar?: string | null
  /** Replaces the whole customData object (Logto's PATCH /api/users/:id semantics). */
  customData?: Record<string, unknown>
}

export class ManagementError extends Error {
  // Plain fields (no parameter properties), so Node can run scripts that import
  // this file with its built-in type stripping.
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ManagementError'
    this.status = status
    this.code = code
  }
}

export interface ManagementOptions {
  /** Logto endpoint, e.g. https://auth.robyrew.com */
  endpoint: string
  appId: string
  appSecret: string
  /** Resource indicator of the Management API: https://default.logto.app/api on a self-hosted Logto. */
  resource?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

export interface ManagementClient {
  getUser(id: string): Promise<LogtoUser>
  listUsers(page: number, pageSize: number): Promise<{ users: LogtoUser[]; total: number }>
  patchUser(id: string, patch: UserPatch): Promise<LogtoUser>
}

/** A Logto user entity (Management API or webhook `data`) → the fields robyrew-id uses. */
export function toUser(raw: unknown): LogtoUser {
  const u = raw as Record<string, unknown>
  if (!u || typeof u.id !== 'string') throw new ManagementError(502, 'bad_user', 'Logto returned a user without an id')
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
  return {
    id: u.id,
    username: str(u.username),
    name: str(u.name),
    avatar: str(u.avatar),
    customData: u.customData && typeof u.customData === 'object' ? (u.customData as Record<string, unknown>) : {},
    isSuspended: u.isSuspended === true,
  }
}

export function createManagementClient(options: ManagementOptions): ManagementClient {
  const endpoint = options.endpoint.replace(/\/+$/, '')
  const resource = options.resource ?? 'https://default.logto.app/api'
  const timeoutMs = options.timeoutMs ?? 8_000
  const doFetch = options.fetch ?? globalThis.fetch
  const basic = Buffer.from(`${encodeURIComponent(options.appId)}:${encodeURIComponent(options.appSecret)}`).toString('base64')
  let cached: { value: string; expiresAt: number } | null = null
  let pending: Promise<string> | null = null

  async function fetchToken(): Promise<string> {
    const res = await doFetch(`${endpoint}/oidc/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', resource, scope: 'all' }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; code?: string; message?: string }
    if (!res.ok || !body.access_token) {
      throw new ManagementError(res.status || 502, body.code ?? 'token_failed', `Management API token: ${body.message ?? res.statusText}`)
    }
    cached = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 }
    return cached.value
  }

  async function token(): Promise<string> {
    // A minute of margin so a token does not expire between this check and Logto's.
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.value
    pending ??= fetchToken().finally(() => {
      pending = null
    })
    return pending
  }

  async function call<T>(method: string, path: string, body?: unknown, retried = false): Promise<{ data: T; headers: Headers }> {
    const res = await doFetch(`${endpoint}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await token()}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 401 && !retried) {
      cached = null
      return call(method, path, body, true)
    }
    const text = await res.text()
    let data: unknown = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = null
      }
    }
    if (!res.ok) {
      const err = (data ?? {}) as { code?: string; message?: string }
      throw new ManagementError(res.status, err.code ?? `http_${res.status}`, err.message ?? res.statusText)
    }
    return { data: data as T, headers: res.headers }
  }

  return {
    async getUser(id) {
      return toUser((await call('GET', `/api/users/${encodeURIComponent(id)}`)).data)
    },
    async listUsers(page, pageSize) {
      const { data, headers } = await call<unknown[]>('GET', `/api/users?page=${page}&page_size=${pageSize}`)
      const users = (Array.isArray(data) ? data : []).map(toUser)
      const total = Number(headers.get('total-number'))
      return { users, total: Number.isFinite(total) ? total : users.length }
    },
    async patchUser(id, patch) {
      return toUser((await call('PATCH', `/api/users/${encodeURIComponent(id)}`, patch)).data)
    },
  }
}

/** Every user, page by page. */
export async function* allUsers(client: ManagementClient, pageSize = 100): AsyncGenerator<LogtoUser> {
  for (let page = 1; ; page++) {
    const { users, total } = await client.listUsers(page, pageSize)
    yield* users
    if (users.length < pageSize || page * pageSize >= total) return
  }
}
