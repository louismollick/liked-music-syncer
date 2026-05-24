import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
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
  autoApproveChanges: false,
  remoteCopyEnabled: false,
  outputFormat: 'm4a',
  rcloneRemote: '',
  remoteMusicRoot: '',
  lyricsApiBaseUrl: '',
  hasYtMusicBrowserAuth: false,
  ytDlpCookiesBrowser: 'firefox',
  folderTemplate: '{albumartist}/{album}',
  fileTemplate: '{track:02d} {title}',
  embedUnsyncedLyrics: true,
  writeLrcSidecar: true,
}

const COOKIES_BROWSER_KEY = 'ytDlpCookiesBrowser'
const COOKIES_BROWSER_EXPLICIT_KEY = 'ytDlpCookiesBrowserExplicit'
const SETTINGS_FILE_VERSION = 1

interface PersistedSettingsFile {
  version: number
  outputDirectory: string
  autoApproveChanges: boolean
  remoteCopyEnabled: boolean
  rcloneRemote: string
  remoteMusicRoot: string
  lyricsApiBaseUrl: string
  ytDlpCookiesBrowser: YtDlpCookiesBrowser
  folderTemplate: string
  fileTemplate: string
  embedUnsyncedLyrics: boolean
  writeLrcSidecar: boolean
}

export interface RuntimeSettings {
  outputDirectory: string
  autoApproveChanges: boolean
  remoteCopyEnabled: boolean
  rcloneRemote: string
  remoteMusicRoot: string
  lyricsApiBaseUrl: string
  ytmusicBrowserAuth: string
  ytDlpCookiesBrowser: YtDlpCookiesBrowser
  folderTemplate: string
  fileTemplate: string
  embedUnsyncedLyrics: boolean
  writeLrcSidecar: boolean
}

export class SettingsService {
  constructor(
    private readonly db: AppDatabase,
    private readonly settingsFile: string
  ) {}

  async getView(): Promise<AppSettingsView> {
    const rows = await this.db.select().from(settingsTable)
    const rowMap = new Map(rows.map((row) => [row.key, row]))
    const persisted = this.readPersistedSettings()

    return {
      ...DEFAULT_SETTINGS,
      outputDirectory:
        persisted?.outputDirectory ??
        this.getPlainValue(rowMap, 'outputDirectory'),
      autoApproveChanges:
        persisted?.autoApproveChanges ??
        this.getBooleanValue(rowMap, 'autoApproveChanges'),
      remoteCopyEnabled:
        persisted?.remoteCopyEnabled ??
        this.getBooleanValue(rowMap, 'remoteCopyEnabled'),
      rcloneRemote:
        persisted?.rcloneRemote ?? this.getPlainValue(rowMap, 'rcloneRemote'),
      remoteMusicRoot:
        persisted?.remoteMusicRoot ??
        this.getPlainValue(rowMap, 'remoteMusicRoot'),
      lyricsApiBaseUrl:
        persisted?.lyricsApiBaseUrl ??
        this.getPlainValue(rowMap, 'lyricsApiBaseUrl'),
      hasYtMusicBrowserAuth: this.hasStoredSecret(rowMap, 'ytmusicBrowserAuth'),
      ytDlpCookiesBrowser:
        persisted?.ytDlpCookiesBrowser ?? this.getCookiesBrowserValue(rowMap),
      folderTemplate:
        persisted?.folderTemplate ||
        this.getPlainValue(rowMap, 'folderTemplate') ||
        DEFAULT_SETTINGS.folderTemplate,
      fileTemplate:
        persisted?.fileTemplate ||
        this.getPlainValue(rowMap, 'fileTemplate') ||
        DEFAULT_SETTINGS.fileTemplate,
      embedUnsyncedLyrics:
        persisted?.embedUnsyncedLyrics ??
        this.getBooleanValue(rowMap, 'embedUnsyncedLyrics', true),
      writeLrcSidecar:
        persisted?.writeLrcSidecar ??
        this.getBooleanValue(rowMap, 'writeLrcSidecar', true),
    }
  }

  async save(input: SaveSettingsInput): Promise<CommandResult> {
    const persisted = this.normalizePersistedSettings(input)
    this.writePersistedSettings(persisted)

    await this.writeValue('outputDirectory', persisted.outputDirectory)
    await this.writeValue(
      'autoApproveChanges',
      String(persisted.autoApproveChanges)
    )
    await this.writeValue(
      'remoteCopyEnabled',
      String(persisted.remoteCopyEnabled)
    )
    await this.writeValue(COOKIES_BROWSER_KEY, persisted.ytDlpCookiesBrowser)
    await this.writeValue(COOKIES_BROWSER_EXPLICIT_KEY, 'true')
    await this.writeValue('rcloneRemote', persisted.rcloneRemote)
    await this.writeValue('remoteMusicRoot', persisted.remoteMusicRoot)
    await this.writeValue('lyricsApiBaseUrl', persisted.lyricsApiBaseUrl)
    await this.writeValue('folderTemplate', persisted.folderTemplate)
    await this.writeValue('fileTemplate', persisted.fileTemplate)
    await this.writeValue(
      'embedUnsyncedLyrics',
      String(persisted.embedUnsyncedLyrics)
    )
    await this.writeValue('writeLrcSidecar', String(persisted.writeLrcSidecar))

    if (input.ytmusicBrowserAuth != null) {
      await this.writeSecret(
        'ytmusicBrowserAuth',
        input.ytmusicBrowserAuth.trim()
      )
    }

    await this.clearLegacyYtMusicOAuthSettings()

    return {
      ok: true,
      message: 'Settings saved.',
    }
  }

  async getRuntimeSettings(): Promise<RuntimeSettings> {
    const persisted = this.readPersistedSettings()
    const storedCookiesBrowser =
      await this.getSecretOrPlain(COOKIES_BROWSER_KEY)
    const cookiesBrowserExplicit =
      (await this.getSecretOrPlain(COOKIES_BROWSER_EXPLICIT_KEY)) === 'true'

    return {
      outputDirectory:
        persisted?.outputDirectory ??
        (await this.getSecretOrPlain('outputDirectory')) ??
        '',
      autoApproveChanges:
        persisted?.autoApproveChanges ??
        ((await this.getSecretOrPlain('autoApproveChanges')) ?? 'false') ===
          'true',
      remoteCopyEnabled:
        persisted?.remoteCopyEnabled ??
        ((await this.getSecretOrPlain('remoteCopyEnabled')) ?? 'false') ===
          'true',
      rcloneRemote:
        persisted?.rcloneRemote ??
        (await this.getSecretOrPlain('rcloneRemote')) ??
        '',
      remoteMusicRoot:
        persisted?.remoteMusicRoot ??
        (await this.getSecretOrPlain('remoteMusicRoot')) ??
        '',
      lyricsApiBaseUrl:
        persisted?.lyricsApiBaseUrl ??
        (await this.getSecretOrPlain('lyricsApiBaseUrl')) ??
        '',
      ytmusicBrowserAuth:
        (await this.getSecretOrPlain('ytmusicBrowserAuth')) ?? '',
      ytDlpCookiesBrowser:
        persisted?.ytDlpCookiesBrowser ??
        this.normalizeCookiesBrowserValue(
          storedCookiesBrowser,
          cookiesBrowserExplicit
        ),
      folderTemplate:
        persisted?.folderTemplate ??
        (await this.getSecretOrPlain('folderTemplate')) ??
        DEFAULT_SETTINGS.folderTemplate,
      fileTemplate:
        persisted?.fileTemplate ??
        (await this.getSecretOrPlain('fileTemplate')) ??
        DEFAULT_SETTINGS.fileTemplate,
      embedUnsyncedLyrics:
        persisted?.embedUnsyncedLyrics ??
        ((await this.getSecretOrPlain('embedUnsyncedLyrics')) ?? 'true') ===
          'true',
      writeLrcSidecar:
        persisted?.writeLrcSidecar ??
        ((await this.getSecretOrPlain('writeLrcSidecar')) ?? 'true') === 'true',
    }
  }

  async saveYtMusicBrowserAuth(browserAuth: string) {
    await this.writeSecret('ytmusicBrowserAuth', browserAuth)
  }

  async clearYtMusicBrowserAuth() {
    await this.writeSecret('ytmusicBrowserAuth', '')
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

  private normalizePersistedSettings(
    input: SaveSettingsInput
  ): PersistedSettingsFile {
    return {
      version: SETTINGS_FILE_VERSION,
      outputDirectory: expandHome(input.outputDirectory.trim()),
      autoApproveChanges: input.autoApproveChanges,
      remoteCopyEnabled: input.remoteCopyEnabled,
      rcloneRemote: input.rcloneRemote.trim(),
      remoteMusicRoot: input.remoteMusicRoot.trim(),
      lyricsApiBaseUrl:
        typeof input.lyricsApiBaseUrl === 'string'
          ? input.lyricsApiBaseUrl.trim()
          : '',
      ytDlpCookiesBrowser: input.ytDlpCookiesBrowser,
      folderTemplate:
        input.folderTemplate.trim() || DEFAULT_SETTINGS.folderTemplate,
      fileTemplate: input.fileTemplate.trim() || DEFAULT_SETTINGS.fileTemplate,
      embedUnsyncedLyrics: input.embedUnsyncedLyrics,
      writeLrcSidecar: input.writeLrcSidecar,
    }
  }

  private readPersistedSettings(): PersistedSettingsFile | null {
    try {
      const raw = readFileSync(this.settingsFile, 'utf8')
      const parsed = JSON.parse(raw) as Partial<PersistedSettingsFile> | null
      if (!parsed || parsed.version !== SETTINGS_FILE_VERSION) {
        return null
      }

      return {
        version: SETTINGS_FILE_VERSION,
        outputDirectory:
          typeof parsed.outputDirectory === 'string'
            ? parsed.outputDirectory
            : '',
        autoApproveChanges: parsed.autoApproveChanges === true,
        remoteCopyEnabled: parsed.remoteCopyEnabled === true,
        rcloneRemote:
          typeof parsed.rcloneRemote === 'string' ? parsed.rcloneRemote : '',
        remoteMusicRoot:
          typeof parsed.remoteMusicRoot === 'string'
            ? parsed.remoteMusicRoot
            : '',
        lyricsApiBaseUrl:
          typeof parsed.lyricsApiBaseUrl === 'string'
            ? parsed.lyricsApiBaseUrl
            : '',
        ytDlpCookiesBrowser: this.normalizeCookiesBrowserValue(
          typeof parsed.ytDlpCookiesBrowser === 'string'
            ? parsed.ytDlpCookiesBrowser
            : null,
          true
        ),
        folderTemplate:
          typeof parsed.folderTemplate === 'string' && parsed.folderTemplate
            ? parsed.folderTemplate
            : DEFAULT_SETTINGS.folderTemplate,
        fileTemplate:
          typeof parsed.fileTemplate === 'string' && parsed.fileTemplate
            ? parsed.fileTemplate
            : DEFAULT_SETTINGS.fileTemplate,
        embedUnsyncedLyrics: parsed.embedUnsyncedLyrics !== false,
        writeLrcSidecar: parsed.writeLrcSidecar !== false,
      }
    } catch {
      return null
    }
  }

  private writePersistedSettings(settings: PersistedSettingsFile) {
    mkdirSync(path.dirname(this.settingsFile), { recursive: true })
    const tempFile = `${this.settingsFile}.tmp`
    writeFileSync(tempFile, JSON.stringify(settings, null, 2))
    renameSync(tempFile, this.settingsFile)
  }

  private async clearLegacyYtMusicOAuthSettings() {
    await this.writeValue('ytmusicAuthMode', 'browser_headers')
    await this.writeValue('ytmusicClientId', '')
    await this.writeSecret('ytmusicClientSecret', '')
    await this.writeSecret('ytmusicOAuthToken', '')
  }

  private hasStoredSecret(
    rowMap: Map<string, { value: string; encrypted: boolean }>,
    key: string
  ) {
    const row = rowMap.get(key)
    return Boolean(row?.encrypted && row.value)
  }
}
