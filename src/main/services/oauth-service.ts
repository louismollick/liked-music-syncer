import type {
  AuthStatus,
  BrowserAuthCaptureResult,
  CommandResult,
  DeviceAuthFinishResult,
  DeviceAuthSessionView,
  DeviceAuthStartResult,
  YtDlpCookiesBrowser,
} from '@shared/contracts'
import { shell } from 'electron'
import type { AppDatabase } from '../db/database'
import { songLogsTable } from '../db/schema'
import type { PythonWorkerService } from './python-worker'
import type { SettingsService } from './settings-service'
import { nowIso } from './utils'

interface PendingDeviceAuth {
  deviceCode: string
  view: DeviceAuthSessionView
}

interface WorkerAuthStartResponse {
  ok: boolean
  message: string
  verification_url?: string
  user_code?: string
  device_code?: string
  interval?: number
  expires_in?: number
}

interface WorkerAuthFinishResponse {
  ok: boolean
  state: 'pending' | 'authorized' | 'expired' | 'failed'
  message: string
  token_json?: string
}

interface WorkerAuthStatusResponse {
  ok: boolean
  is_authenticated: boolean
  message: string
  credential_json?: string
}

export class OAuthService {
  private pendingDeviceAuth: PendingDeviceAuth | null = null
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
    const settings = await this.settingsService.getView()
    const runtime = await this.settingsService.getRuntimeSettings()
    const authMode = settings.ytmusicAuthMode ?? 'oauth_device'
    const hasClientConfig = Boolean(
      runtime.ytmusicClientId && runtime.ytmusicClientSecret
    )
    const hasOAuthToken = Boolean(runtime.ytmusicOAuthTokenJson)
    const hasBrowserAuth = Boolean(runtime.ytmusicBrowserAuth)

    let isAuthenticated = false

    if (authMode === 'oauth_device' && hasClientConfig && hasOAuthToken) {
      try {
        const result =
          await this.pythonWorker.runJsonCommand<WorkerAuthStatusResponse>(
            'auth-status',
            {
              mode: authMode,
              client_id: runtime.ytmusicClientId,
              client_secret: runtime.ytmusicClientSecret,
              token_json: runtime.ytmusicOAuthTokenJson,
            }
          )

        isAuthenticated = result.ok && result.is_authenticated
        if (result.credential_json) {
          await this.settingsService.saveYtMusicOAuthToken(
            result.credential_json
          )
        }
        this.lastError = result.ok ? null : result.message
        if (!result.ok) {
          await this.persistAuthFailure(
            options?.persistFailureSource,
            authMode,
            result.message
          )
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
        await this.persistAuthFailure(
          options?.persistFailureSource,
          authMode,
          this.lastError
        )
      }
    } else if (authMode === 'browser_headers' && hasBrowserAuth) {
      try {
        const result =
          await this.pythonWorker.runJsonCommand<WorkerAuthStatusResponse>(
            'auth-status',
            {
              mode: authMode,
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
            authMode,
            result.message
          )
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
        await this.persistAuthFailure(
          options?.persistFailureSource,
          authMode,
          this.lastError
        )
      }
    } else {
      this.lastError = null
    }

    return {
      authMode,
      hasClientConfig,
      isAuthenticated,
      hasOAuthToken,
      hasBrowserAuth,
      pendingDeviceAuth: this.pendingDeviceAuth?.view ?? null,
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
      runId: OAuthService.AUTH_LOG_RUN_ID,
      itemId: OAuthService.AUTH_LOG_ITEM_ID,
      sourceVideoId: OAuthService.AUTH_LOG_SOURCE_VIDEO_ID,
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

  async startDeviceAuth(): Promise<DeviceAuthStartResult> {
    const runtime = await this.settingsService.getRuntimeSettings()
    if (runtime.ytmusicAuthMode !== 'oauth_device') {
      return {
        ok: false,
        message: 'Switch auth mode to OAuth device to use device login.',
        pendingDeviceAuth: null,
      }
    }
    if (!runtime.ytmusicClientId || !runtime.ytmusicClientSecret) {
      return {
        ok: false,
        message: 'YT Music client ID and secret must be saved first.',
        pendingDeviceAuth: null,
      }
    }

    const result =
      await this.pythonWorker.runJsonCommand<WorkerAuthStartResponse>(
        'auth-start',
        {
          client_id: runtime.ytmusicClientId,
          client_secret: runtime.ytmusicClientSecret,
        }
      )

    if (
      !result.ok ||
      !result.verification_url ||
      !result.user_code ||
      !result.device_code ||
      !result.interval ||
      !result.expires_in
    ) {
      this.lastError = result.message
      return {
        ok: false,
        message: result.message,
        pendingDeviceAuth: null,
      }
    }

    const startedAt = new Date()
    const expiresAt = new Date(
      startedAt.getTime() + result.expires_in * 1000
    ).toISOString()

    this.pendingDeviceAuth = {
      deviceCode: result.device_code,
      view: {
        verificationUrl: result.verification_url,
        userCode: result.user_code,
        intervalSeconds: result.interval,
        expiresAt,
        startedAt: startedAt.toISOString(),
      },
    }

    this.lastError = null
    await shell.openExternal(result.verification_url)

    return {
      ok: true,
      message: result.message,
      pendingDeviceAuth: this.pendingDeviceAuth.view,
    }
  }

  async finishDeviceAuth(): Promise<DeviceAuthFinishResult> {
    if (!this.pendingDeviceAuth) {
      return {
        ok: false,
        message: 'No YT Music device authorization is pending.',
        state: 'failed',
        authStatus: await this.getStatus(),
      }
    }

    const runtime = await this.settingsService.getRuntimeSettings()
    const result =
      await this.pythonWorker.runJsonCommand<WorkerAuthFinishResponse>(
        'auth-finish',
        {
          client_id: runtime.ytmusicClientId,
          client_secret: runtime.ytmusicClientSecret,
          device_code: this.pendingDeviceAuth.deviceCode,
        }
      )

    if (result.state === 'authorized' && result.token_json) {
      await this.settingsService.saveYtMusicOAuthToken(result.token_json)
      this.pendingDeviceAuth = null
      this.lastError = null
    } else if (result.state === 'expired' || result.state === 'failed') {
      this.pendingDeviceAuth = null
      this.lastError = result.message
    }

    return {
      ok: result.ok,
      message: result.message,
      state: result.state,
      authStatus: await this.getStatus(),
    }
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
    this.pendingDeviceAuth = null
    this.lastError = null
    const runtime = await this.settingsService.getRuntimeSettings()
    if (runtime.ytmusicAuthMode === 'browser_headers') {
      await this.settingsService.clearYtMusicBrowserAuth()
    } else {
      await this.settingsService.clearYtMusicOAuthToken()
    }
    return {
      ok: true,
      message: 'YT Music account disconnected.',
    }
  }
}
