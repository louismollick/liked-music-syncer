import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  emptyLmsFields,
  fieldDiff,
  LMS_TAG_SCHEMA_VERSION,
  readTags,
  sha256,
  type TagFields,
  writeTags,
} from '../../src/main/tags/schema'
import { makeM4a, TINY_JPEG, tempDir } from '../helpers/audio'

function sampleFields(overrides: Partial<TagFields> = {}): TagFields {
  return {
    title: '餌にもならない愛を',
    artist: 'tricot, ゲスト',
    album: '10',
    albumArtist: 'tricot',
    trackNumber: 1,
    trackTotal: 10,
    discNumber: 1,
    discTotal: 2,
    date: '2020-05',
    genre: 'Math Rock; J-Rock',
    language: 'ja',
    isrc: 'JPU902000001',
    mbRecordingId: '318f5894-23cc-42ca-88a0-bfa492af7f05',
    lyrics: '[00:01.16]line one\n[00:05.25]line two',
    coverSha256: sha256(TINY_JPEG),
    lms: {
      ...emptyLmsFields(),
      schemaVersion: LMS_TAG_SCHEMA_VERSION,
      sourceVideoId: 'NR7dG_m3MsI',
      resolvedVideoId: 'sFxLbPG09xI',
      sourceOrigin: 'liked',
      resolutionMethod: 'search_song_exact',
      releaseBrowseId: 'MPREb_xG4dJ4ZbIcJ',
      releaseTitle: '10',
      releaseKind: 'album',
      artistCredits: [
        { name: 'tricot', channelId: 'UC5zlgZh4XYI0z2NAXAji-5A' },
        { name: 'ゲスト', channelId: null },
      ],
    },
    ...overrides,
  }
}

describe('tag schema', () => {
  it('round-trips every app-owned field, including a partial date', () => {
    const file = makeM4a(path.join(tempDir(), 'a.m4a'))
    const fields = sampleFields()
    writeTags(file, fields, TINY_JPEG)
    const read = readTags(file)
    expect(fieldDiff(read.fields, fields)).toEqual([])
    expect(read.fields.date).toBe('2020-05')
    expect(Buffer.from(read.cover!)).toEqual(TINY_JPEG)
    expect(read.durationSeconds).toBeGreaterThan(0.3)
  })

  it('round-trips match confirmation and treats a missing record field as unconfirmed', () => {
    const file = makeM4a(path.join(tempDir(), 'c.m4a'))
    const confirmed = sampleFields()
    confirmed.lms.matchConfirmed = true
    writeTags(file, confirmed, null)
    expect(readTags(file).fields.lms.matchConfirmed).toBe(true)
    const unconfirmed = sampleFields()
    writeTags(file, unconfirmed, null)
    const read = readTags(file).fields
    expect(read.lms.matchConfirmed).toBe(false)
    const older = JSON.parse(JSON.stringify(read)) as {
      lms: Record<string, unknown>
    }
    delete older.lms.matchConfirmed
    expect(fieldDiff(read, older as unknown as TagFields)).toEqual([])
  })

  it('keeps year-only and full dates distinct', () => {
    const file = makeM4a(path.join(tempDir(), 'b.m4a'))
    writeTags(file, sampleFields({ date: '2019' }), null)
    expect(readTags(file).fields.date).toBe('2019')
    writeTags(
      file,
      sampleFields({ date: '2019-11-02', coverSha256: null }),
      null
    )
    const read = readTags(file)
    expect(read.fields.date).toBe('2019-11-02')
    expect(read.cover).toBeNull()
  })

  it('clears optional fields when rewritten as null', () => {
    const file = makeM4a(path.join(tempDir(), 'c.m4a'))
    writeTags(file, sampleFields(), TINY_JPEG)
    writeTags(
      file,
      sampleFields({
        isrc: null,
        lyrics: null,
        genre: null,
        coverSha256: null,
      }),
      null
    )
    const read = readTags(file)
    expect(read.fields.isrc).toBeNull()
    expect(read.fields.lyrics).toBeNull()
    expect(read.fields.genre).toBeNull()
    expect(read.fields.coverSha256).toBeNull()
  })

  it('reports untagged files as having no LMS schema version', () => {
    const file = makeM4a(path.join(tempDir(), 'd.m4a'))
    const read = readTags(file)
    expect(read.fields.lms.schemaVersion).toBeNull()
    expect(read.fields.title).toBeNull()
  })

  it('names the fields that differ', () => {
    const a = sampleFields()
    const b = sampleFields({
      album: 'Other',
      lms: { ...a.lms, releaseBrowseId: 'MPREb_other' },
    })
    expect(fieldDiff(a, b)).toEqual(['album', 'lms.releaseBrowseId'])
  })
})
