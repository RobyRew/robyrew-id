// Server configuration, read from process.env at runtime (never PUBLIC_*: these
// are secrets and must not reach the client bundle).

export interface Env {
  /** Public origin, e.g. https://id.robyrew.com */
  siteUrl: string
  logtoEndpoint: string
  /** Traditional Web app "RobyRew ID". */
  appId: string
  appSecret: string
  /** Seals session rows (openssl rand -base64 32). */
  cookieSecret: string
  /** Machine-to-machine app with the "Logto Management API access" role. */
  m2mAppId: string
  m2mAppSecret: string
  managementResource: string
  /** Signing key of this app's webhook in the Logto console. */
  webhookSigningKey: string
  /** SQLite file and avatars/ live here: a named, backed-up volume in production. */
  dataDir: string
}

export function readEnv(source: Record<string, string | undefined> = process.env): Env {
  const missing: string[] = []
  const need = (name: string) => {
    const value = source[name]?.trim()
    if (!value) missing.push(name)
    return value ?? ''
  }
  const env: Env = {
    siteUrl: need('PUBLIC_SITE_URL').replace(/\/+$/, ''),
    logtoEndpoint: need('LOGTO_ENDPOINT').replace(/\/+$/, ''),
    appId: need('LOGTO_APP_ID'),
    appSecret: need('LOGTO_APP_SECRET'),
    cookieSecret: need('LOGTO_COOKIE_SECRET'),
    m2mAppId: need('LOGTO_M2M_APP_ID'),
    m2mAppSecret: need('LOGTO_M2M_APP_SECRET'),
    managementResource: source.LOGTO_MANAGEMENT_RESOURCE?.trim() || 'https://default.logto.app/api',
    webhookSigningKey: need('LOGTO_WEBHOOK_SIGNING_KEY'),
    dataDir: source.DATA_DIR?.trim() || './data',
  }
  if (missing.length) throw new Error(`robyrew-id: missing environment variables: ${missing.join(', ')}`)
  return env
}
