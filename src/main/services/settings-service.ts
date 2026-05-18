import type {
  AppSettingsView,
  BinaryStatus,
  CommandResult,
  SaveSettingsInput,
  YtDlpCookiesBrowser,
} from '@shared/contracts'
import { eq } from 'drizzle-orm'
import { safeStorage } from 'electron'
import type { AppDatabase } from '../db/database'
import { settingsTable } from '../db/schema'
import { expandHome, nowIso } from './utils'

const DEFAULT_SETTINGS: AppSettingsView = {
  outputDirectory: '',
  dryRun: false,
  remoteCopyEnabled: false,
  outputFormat: 'm4a',
  rcloneRemote: '',
  remoteMusicRoot: '',
  ytmusicAuthMode: 'oauth_device',
  ytmusicClientId: '',
  hasYtMusicClientSecret: false,
  hasYtMusicOAuthToken: false,
  hasYtMusicBrowserAuth: false,
  ytDlpCookiesBrowser: 'firefox',
  folderTemplate: '{albumartist}/{album}',
  fileTemplate: '{track:02d} {title}',
  embedUnsyncedLyrics: true,
  writeLrcSidecar: true,
}

const COOKIES_BROWSER_KEY = 'ytDlpCookiesBrowser'
const COOKIES_BROWSER_EXPLICIT_KEY = 'ytDlpCookiesBrowserExplicit'

export interface RuntimeSettings {
  outputDirectory: string
  dryRun: boolean
  remoteCopyEnabled: boolean
  rcloneRemote: string
  remoteMusicRoot: string
  ytmusicAuthMode: AppSettingsView['ytmusicAuthMode']
  ytmusicClientId: string
  ytmusicClientSecret: string
  ytmusicOAuthTokenJson: string
  ytmusicBrowserAuth: string
  ytDlpCookiesBrowser: YtDlpCookiesBrowser
  folderTemplate: string
  fileTemplate: string
  embedUnsyncedLyrics: boolean
  writeLrcSidecar: boolean
}

export class SettingsService {
  constructor(private readonly db: AppDatabase) {}

  async getView(): Promise<AppSettingsView> {
    const rows = await this.db.select().from(settingsTable)
    const rowMap = new Map(rows.map((row) => [row.key, row]))

    return {
      ...DEFAULT_SETTINGS,
      outputDirectory: this.getPlainValue(rowMap, 'outputDirectory'),
      dryRun: this.getBooleanValue(rowMap, 'dryRun'),
      remoteCopyEnabled: this.getBooleanValue(rowMap, 'remoteCopyEnabled'),
      rcloneRemote: this.getPlainValue(rowMap, 'rcloneRemote'),
      remoteMusicRoot: this.getPlainValue(rowMap, 'remoteMusicRoot'),
      ytmusicAuthMode: this.getAuthModeValue(rowMap),
      ytmusicClientId: this.getPlainValue(rowMap, 'ytmusicClientId'),
      hasYtMusicClientSecret: this.hasStoredSecret(
        rowMap,
        'ytmusicClientSecret'
      ),
      hasYtMusicOAuthToken: this.hasStoredSecret(rowMap, 'ytmusicOAuthToken'),
      hasYtMusicBrowserAuth: this.hasStoredSecret(rowMap, 'ytmusicBrowserAuth'),
      ytDlpCookiesBrowser: this.getCookiesBrowserValue(rowMap),
      folderTemplate:
        this.getPlainValue(rowMap, 'folderTemplate') ||
        DEFAULT_SETTINGS.folderTemplate,
      fileTemplate:
        this.getPlainValue(rowMap, 'fileTemplate') ||
        DEFAULT_SETTINGS.fileTemplate,
      embedUnsyncedLyrics: this.getBooleanValue(
        rowMap,
        'embedUnsyncedLyrics',
        true
      ),
      writeLrcSidecar: this.getBooleanValue(rowMap, 'writeLrcSidecar', true),
    }
  }

  async save(input: SaveSettingsInput): Promise<CommandResult> {
    await this.writeValue(
      'outputDirectory',
      expandHome(input.outputDirectory.trim())
    )
    await this.writeValue('dryRun', String(input.dryRun))
    await this.writeValue('remoteCopyEnabled', String(input.remoteCopyEnabled))
    await this.writeValue('ytmusicAuthMode', input.ytmusicAuthMode)
    await this.writeValue('ytmusicClientId', input.ytmusicClientId.trim())
    await this.writeValue(COOKIES_BROWSER_KEY, input.ytDlpCookiesBrowser)
    await this.writeValue(COOKIES_BROWSER_EXPLICIT_KEY, 'true')
    await this.writeValue('rcloneRemote', input.rcloneRemote.trim())
    await this.writeValue('remoteMusicRoot', input.remoteMusicRoot.trim())
    await this.writeValue(
      'folderTemplate',
      input.folderTemplate.trim() || DEFAULT_SETTINGS.folderTemplate
    )
    await this.writeValue(
      'fileTemplate',
      input.fileTemplate.trim() || DEFAULT_SETTINGS.fileTemplate
    )
    await this.writeValue(
      'embedUnsyncedLyrics',
      String(input.embedUnsyncedLyrics)
    )
    await this.writeValue('writeLrcSidecar', String(input.writeLrcSidecar))

    if (input.ytmusicClientSecret?.trim()) {
      await this.writeSecret(
        'ytmusicClientSecret',
        input.ytmusicClientSecret.trim()
      )
    }

    if (input.ytmusicBrowserAuth != null) {
      await this.writeSecret(
        'ytmusicBrowserAuth',
        input.ytmusicBrowserAuth.trim()
      )
    }

    return {
      ok: true,
      message: 'Settings saved.',
    }
  }

  async getRuntimeSettings(): Promise<RuntimeSettings> {
    const storedCookiesBrowser =
      await this.getSecretOrPlain(COOKIES_BROWSER_KEY)
    const cookiesBrowserExplicit =
      (await this.getSecretOrPlain(COOKIES_BROWSER_EXPLICIT_KEY)) === 'true'

    return {
      outputDirectory: (await this.getSecretOrPlain('outputDirectory')) ?? '',
      dryRun: ((await this.getSecretOrPlain('dryRun')) ?? 'false') === 'true',
      remoteCopyEnabled:
        ((await this.getSecretOrPlain('remoteCopyEnabled')) ?? 'false') ===
        'true',
      rcloneRemote: (await this.getSecretOrPlain('rcloneRemote')) ?? '',
      remoteMusicRoot: (await this.getSecretOrPlain('remoteMusicRoot')) ?? '',
      ytmusicAuthMode:
        ((await this.getSecretOrPlain('ytmusicAuthMode')) as
          | AppSettingsView['ytmusicAuthMode']
          | null) ?? DEFAULT_SETTINGS.ytmusicAuthMode,
      ytmusicClientId: (await this.getSecretOrPlain('ytmusicClientId')) ?? '',
      ytmusicClientSecret:
        (await this.getSecretOrPlain('ytmusicClientSecret')) ?? '',
      ytmusicOAuthTokenJson:
        (await this.getSecretOrPlain('ytmusicOAuthToken')) ?? '',
      ytmusicBrowserAuth:
        (await this.getSecretOrPlain('ytmusicBrowserAuth')) ?? '',
      ytDlpCookiesBrowser: this.normalizeCookiesBrowserValue(
        storedCookiesBrowser,
        cookiesBrowserExplicit
      ),
      folderTemplate:
        (await this.getSecretOrPlain('folderTemplate')) ??
        DEFAULT_SETTINGS.folderTemplate,
      fileTemplate:
        (await this.getSecretOrPlain('fileTemplate')) ??
        DEFAULT_SETTINGS.fileTemplate,
      embedUnsyncedLyrics:
        ((await this.getSecretOrPlain('embedUnsyncedLyrics')) ?? 'true') ===
        'true',
      writeLrcSidecar:
        ((await this.getSecretOrPlain('writeLrcSidecar')) ?? 'true') === 'true',
    }
  }

  async saveYtMusicOAuthToken(tokenJson: string) {
    await this.writeSecret('ytmusicOAuthToken', tokenJson)
  }

  async saveYtMusicBrowserAuth(browserAuth: string) {
    await this.writeSecret('ytmusicBrowserAuth', browserAuth)
  }

  async clearYtMusicOAuthToken() {
    await this.writeSecret('ytmusicOAuthToken', '')
  }

  async clearYtMusicBrowserAuth() {
    await this.writeSecret('ytmusicBrowserAuth', '')
  }

  async getYtMusicOAuthToken() {
    return (await this.getSecretOrPlain('ytmusicOAuthToken')) ?? ''
  }

  async testRemote(): Promise<CommandResult> {
    const runtime = await this.getRuntimeSettings()
    if (!runtime.rcloneRemote || !runtime.remoteMusicRoot) {
      return { ok: false, message: 'Remote copy settings are incomplete.' }
    }

    return {
      ok: true,
      message: `Remote copy is configured for ${runtime.rcloneRemote}:${runtime.remoteMusicRoot}`,
    }
  }

  async testBinaries(
    getBundledFfmpegPath: () => string
  ): Promise<BinaryStatus> {
    return {
      uv: 'uv',
      ffmpeg: getBundledFfmpegPath(),
      rclone: 'rclone',
    }
  }

  private async getSecretOrPlain(key: string) {
    const row = await this.db.query.settingsTable.findFirst({
      where: eq(settingsTable.key, key),
    })

    if (!row) return null
    if (!row.encrypted) return row.value
    if (!row.value) return ''

    const decrypted = safeStorage.decryptString(
      Buffer.from(row.value, 'base64')
    )
    return decrypted
  }

  private async writeValue(key: string, value: string) {
    await this.db
      .insert(settingsTable)
      .values({
        key,
        value,
        encrypted: false,
        updatedAt: nowIso(),
      })
      .onConflictDoUpdate({
        target: settingsTable.key,
        set: {
          value,
          encrypted: false,
          updatedAt: nowIso(),
        },
      })
  }

  private async writeSecret(key: string, value: string) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Electron safeStorage is not available on this machine.')
    }

    const encryptedValue = value
      ? safeStorage.encryptString(value).toString('base64')
      : ''

    await this.db
      .insert(settingsTable)
      .values({
        key,
        value: encryptedValue,
        encrypted: true,
        updatedAt: nowIso(),
      })
      .onConflictDoUpdate({
        target: settingsTable.key,
        set: {
          value: encryptedValue,
          encrypted: true,
          updatedAt: nowIso(),
        },
      })
  }

  private getBooleanValue(
    rowMap: Map<string, { value: string }>,
    key: string,
    fallback = false
  ) {
    const value = rowMap.get(key)?.value
    if (value == null || value === '') return fallback
    return value === 'true'
  }

  private getPlainValue(rowMap: Map<string, { value: string }>, key: string) {
    return rowMap.get(key)?.value ?? ''
  }

  private getAuthModeValue(
    rowMap: Map<string, { value: string }>
  ): AppSettingsView['ytmusicAuthMode'] {
    const value = rowMap.get('ytmusicAuthMode')?.value
    return value === 'browser_headers' ? 'browser_headers' : 'oauth_device'
  }

  private getCookiesBrowserValue(
    rowMap: Map<string, { value: string }>
  ): YtDlpCookiesBrowser {
    return this.normalizeCookiesBrowserValue(
      rowMap.get(COOKIES_BROWSER_KEY)?.value ?? null,
      rowMap.get(COOKIES_BROWSER_EXPLICIT_KEY)?.value === 'true'
    )
  }

  private normalizeCookiesBrowserValue(
    value: string | null,
    explicit = false
  ): YtDlpCookiesBrowser {
    if (value === 'chrome' && !explicit) {
      return DEFAULT_SETTINGS.ytDlpCookiesBrowser
    }

    switch (value) {
      case 'brave':
      case 'chrome':
      case 'chromium':
      case 'edge':
      case 'firefox':
      case 'opera':
      case 'safari':
      case 'vivaldi':
      case 'whale':
        return value
      default:
        return DEFAULT_SETTINGS.ytDlpCookiesBrowser
    }
  }

  private hasStoredSecret(
    rowMap: Map<string, { value: string; encrypted: boolean }>,
    key: string
  ) {
    const row = rowMap.get(key)
    return Boolean(row?.encrypted && row.value)
  }
}
