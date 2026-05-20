import type {
  AuthStatus,
  BrowserAuthCaptureResult,
  CommandResult,
  YtDlpCookiesBrowser,
} from '@shared/contracts'
import type { AppDatabase } from '../db/database'
import { songLogsTable } from '../db/schema'
import type { PythonWorkerService } from './python-worker'
import type { SettingsService } from './settings-service'
import { nowIso } from './utils'

interface WorkerAuthStatusResponse {
  ok: boolean
  is_authenticated: boolean
  message: string
  credential_json?: string
}

export class AuthService {
  private lastError: string | null = null
  private static readonly AUTH_LOG_RUN_ID = '__auth__'
  private static readonly AUTH_LOG_ITEM_ID = '__auth__'
  private static readonly AUTH_LOG_SOURCE_VIDEO_ID = '__auth__'

  constructor(
    private readonly db: AppDatabase,
    private readonly settingsService: SettingsService,
    private readonly pythonWorker: PythonWorkerService
  ) {}

  async getStatus(options?: {
    persistFailureSource?: string
  }): Promise<AuthStatus> {
    const runtime = await this.settingsService.getRuntimeSettings()
    const hasBrowserAuth = Boolean(runtime.ytmusicBrowserAuth)
    let isAuthenticated = false

    if (hasBrowserAuth) {
      try {
        const result =
          await this.pythonWorker.runJsonCommand<WorkerAuthStatusResponse>(
            'auth-status',
            {
              browser_auth_input: runtime.ytmusicBrowserAuth,
            }
          )

        isAuthenticated = result.ok && result.is_authenticated
        if (result.credential_json) {
          await this.settingsService.saveYtMusicBrowserAuth(
            result.credential_json
          )
        }
        this.lastError = result.ok ? null : result.message
        if (!result.ok) {
          await this.persistAuthFailure(
            options?.persistFailureSource,
            'browser_headers',
            result.message
          )
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
        await this.persistAuthFailure(
          options?.persistFailureSource,
          'browser_headers',
          this.lastError
        )
      }
    } else {
      this.lastError = null
    }

    return {
      authMode: hasBrowserAuth ? 'browser_headers' : 'none',
      isAuthenticated,
      hasBrowserAuth,
      lastError: this.lastError,
    }
  }

  private async persistAuthFailure(
    source: string | undefined,
    authMode: AuthStatus['authMode'],
    message: string
  ) {
    if (!source) return

    await this.db.insert(songLogsTable).values({
      runId: AuthService.AUTH_LOG_RUN_ID,
      itemId: AuthService.AUTH_LOG_ITEM_ID,
      youtubeMusicTrackId: AuthService.AUTH_LOG_SOURCE_VIDEO_ID,
      timestamp: nowIso(),
      level: 'warn',
      stage: 'ytmusic_auth',
      event: 'auth-status-failed',
      message,
      contextJson: JSON.stringify({
        auth_mode: authMode,
        source,
      }),
    })
  }

  async captureBrowserAuth(
    browser: YtDlpCookiesBrowser
  ): Promise<BrowserAuthCaptureResult> {
    const result =
      await this.pythonWorker.runJsonCommand<WorkerAuthStatusResponse>(
        'auth-capture-browser',
        {
          browser,
        }
      )

    if (result.ok && result.credential_json) {
      await this.settingsService.saveYtMusicBrowserAuth(result.credential_json)
      this.lastError = null
    } else {
      this.lastError = result.message
      await this.persistAuthFailure(
        'browser_cookie_capture',
        'browser_headers',
        result.message
      )
    }

    return {
      ok: result.ok,
      message: result.message,
      authStatus: await this.getStatus(),
    }
  }

  async disconnect(): Promise<CommandResult> {
    this.lastError = null
    await this.settingsService.clearYtMusicBrowserAuth()
    return {
      ok: true,
      message: 'YT Music account disconnected.',
    }
  }
}
