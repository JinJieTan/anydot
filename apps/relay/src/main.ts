import { configFromEnv } from './config'
import { startRelay, VERSION } from './server'

const config = configFromEnv()
const relay = await startRelay(config)
console.log(
  `aitech-relay ${VERSION} listening on ${config.host}:${config.port} (auth: ${config.auth}${
    config.mobileDir ? `, mobile app: /m/` : ''
  })`,
)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void relay.close().then(() => process.exit(0))
  })
}
