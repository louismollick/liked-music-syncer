import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}))

import { createDatabase } from '../src/main/db/database'
import { SettingsService } from '../src/main/services/settings-service'

function makeTempDb(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-settings-'))
  const databaseFile = path.join(dir, `${name}.db`)
  return {
    dir,
    ...createDatabase(databaseFile),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('settings persistence', () => {
  it('persists plain settings to a JSON file and reloads them without the old DB', async () => {
    const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-config-'))
    const settingsFile = path.join(settingsDir, 'settings.json')

    const first = makeTempDb('first')
    const firstService = new SettingsService(first.db, settingsFile)

    await firstService.save({
      outputDirectory: '~/Music/liked',
      dryRun: true,
      remoteCopyEnabled: true,
      ytDlpCookiesBrowser: 'chrome',
      rcloneRemote: 'seedbox',
      remoteMusicRoot: '/music/liked',
      lyricsApiBaseUrl: 'https://lyrics.example.test/api',
      folderTemplate: '{artist}/{album}',
      fileTemplate: '{title}',
      embedUnsyncedLyrics: false,
      writeLrcSidecar: false,
    })

    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))).toMatchObject({
      outputDirectory: path.join(os.homedir(), 'Music/liked'),
      remoteCopyEnabled: true,
      rcloneRemote: 'seedbox',
      remoteMusicRoot: '/music/liked',
      lyricsApiBaseUrl: 'https://lyrics.example.test/api',
      ytDlpCookiesBrowser: 'chrome',
    })

    first.sqlite.close()
    fs.rmSync(first.dir, { recursive: true, force: true })

    const second = makeTempDb('second')
    const secondService = new SettingsService(second.db, settingsFile)

    await expect(secondService.getView()).resolves.toMatchObject({
      outputDirectory: path.join(os.homedir(), 'Music/liked'),
      dryRun: true,
      remoteCopyEnabled: true,
      rcloneRemote: 'seedbox',
      remoteMusicRoot: '/music/liked',
      lyricsApiBaseUrl: 'https://lyrics.example.test/api',
      ytDlpCookiesBrowser: 'chrome',
      folderTemplate: '{artist}/{album}',
      fileTemplate: '{title}',
      embedUnsyncedLyrics: false,
      writeLrcSidecar: false,
    })

    await expect(secondService.getRuntimeSettings()).resolves.toMatchObject({
      outputDirectory: path.join(os.homedir(), 'Music/liked'),
      dryRun: true,
      remoteCopyEnabled: true,
      rcloneRemote: 'seedbox',
      remoteMusicRoot: '/music/liked',
      lyricsApiBaseUrl: 'https://lyrics.example.test/api',
      ytDlpCookiesBrowser: 'chrome',
      folderTemplate: '{artist}/{album}',
      fileTemplate: '{title}',
      embedUnsyncedLyrics: false,
      writeLrcSidecar: false,
    })

    second.sqlite.close()
    fs.rmSync(second.dir, { recursive: true, force: true })
    fs.rmSync(settingsDir, { recursive: true, force: true })
  })
})
