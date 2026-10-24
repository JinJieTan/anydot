import type { AuthMode } from '@aitech/protocol'

export interface RelayConfig {
  port: number
  host: string
  auth: AuthMode
  /** token mode: shared secret clients must present. */
  authToken?: string
  /** Enables the admin page at /admin; sent as a Bearer token. */
  adminToken?: string
  /** upstream mode: base URLs whose API keys may use this relay. */
  allowedUpstreams: string[]
  dataDir: string
  /** Directory with the built mobile web app, served at /m/. */
  mobileDir?: string
  /** Public URL of this relay, used to advertise the mobile app link. */
  publicUrl?: string
  vapidSubject: string
  maxConnectionsPerIp: number
  /** Messages per second per connection (burst = 2×). */
  messageRate: number
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const auth = (env.AUTH_MODE ?? 'open') as AuthMode
  if (!['open', 'token', 'upstream'].includes(auth))
    throw new Error(`AUTH_MODE must be open, token or upstream`)
  // With an admin page, tokens can be created there instead.
  if (auth === 'token' && !env.AUTH_TOKEN && !env.ADMIN_TOKEN)
    throw new Error('AUTH_MODE=token requires AUTH_TOKEN or ADMIN_TOKEN')
  if (env.ADMIN_TOKEN && env.ADMIN_TOKEN.length < 16)
    throw new Error('ADMIN_TOKEN must be at least 16 characters')
  const allowedUpstreams = (env.ALLOWED_UPSTREAMS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (auth === 'upstream' && !allowedUpstreams.length) {
    throw new Error('AUTH_MODE=upstream requires ALLOWED_UPSTREAMS (comma-separated base URLs)')
  }
  return {
    port: Number(env.PORT ?? 8090),
    host: env.HOST ?? '0.0.0.0',
    auth,
    authToken: env.AUTH_TOKEN,
    adminToken: env.ADMIN_TOKEN,
    allowedUpstreams,
    dataDir: env.DATA_DIR ?? './data',
    mobileDir: env.MOBILE_DIR,
    publicUrl: env.PUBLIC_URL,
    vapidSubject: env.VAPID_SUBJECT ?? 'mailto:admin@localhost',
    maxConnectionsPerIp: Number(env.MAX_CONNECTIONS_PER_IP ?? 20),
    messageRate: Number(env.MESSAGE_RATE ?? 50),
  }
}
