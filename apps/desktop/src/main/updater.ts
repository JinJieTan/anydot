import { app, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatusDTO } from '../shared/ipc'

const REPO = 'https://github.com/JinJieTan/anydot'
const CHECK_EVERY = 6 * 60 * 60_000
const FIRST_CHECK_AFTER = 15_000

/**
 * Checks GitHub Releases for a newer version.
 *
 * Windows downloads in the background and installs on "restart to update".
 * macOS only tells the user: installing an update in place needs a Developer ID
 * signature, which our builds don't have yet, so the button opens the new .dmg.
 */
export class Updater {
  private status: UpdateStatusDTO = {
    state: app.isPackaged ? 'idle' : 'unsupported',
    current: app.getVersion(),
    version: null,
    progress: null,
    error: null,
  }
  private readonly installsInPlace = process.platform === 'win32'
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly notify: (status: UpdateStatusDTO) => void) {}

  start(): void {
    if (!app.isPackaged) return
    autoUpdater.logger = {
      info: (m: unknown) => console.info('[updater]', m),
      warn: (m: unknown) => console.warn('[updater]', m),
      error: (m: unknown) => console.error('[updater]', m),
      debug: () => {},
    }
    autoUpdater.autoDownload = this.installsInPlace
    // Our quit path exits outright, so installing on quit wouldn't run; the user restarts from the button.
    autoUpdater.autoInstallOnAppQuit = false

    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking', error: null }))
    autoUpdater.on('update-not-available', () => this.set({ state: 'latest' }))
    autoUpdater.on('update-available', (info) =>
      this.set({
        state: this.installsInPlace ? 'downloading' : 'available',
        version: info.version,
        progress: 0,
      }),
    )
    autoUpdater.on('download-progress', (p) => this.set({ progress: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (info) =>
      this.set({ state: 'ready', version: info.version, progress: 100 }),
    )
    autoUpdater.on('error', (err) => {
      // A failed check isn't worth a warning badge; keep whatever we knew before.
      const known = this.status.state === 'available' || this.status.state === 'ready'
      this.set({ state: known ? this.status.state : 'error', error: err.message })
    })

    setTimeout(() => void this.check(), FIRST_CHECK_AFTER).unref?.()
    this.timer = setInterval(() => void this.check(), CHECK_EVERY)
    this.timer.unref?.()
  }

  get(): UpdateStatusDTO {
    return this.status
  }

  async check(): Promise<UpdateStatusDTO> {
    if (!app.isPackaged) return this.status
    // Don't restart a download in progress or drop one that's ready.
    if (this.status.state === 'downloading' || this.status.state === 'ready') return this.status
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      // Reported through the 'error' event.
    }
    return this.status
  }

  /** Windows: restart into the downloaded update. macOS: open the new installer's download. */
  async install(): Promise<void> {
    const { state, version } = this.status
    if (state === 'ready') {
      autoUpdater.quitAndInstall(false, true)
      return
    }
    await shell.openExternal(version ? macDownloadUrl(version) : `${REPO}/releases/latest`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  private set(patch: Partial<UpdateStatusDTO>) {
    this.status = { ...this.status, ...patch }
    this.notify(this.status)
  }
}

function macDownloadUrl(version: string): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return `${REPO}/releases/download/v${version}/AnyDot-${version}-mac-${arch}.dmg`
}
