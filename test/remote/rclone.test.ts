import { execFileSync } from 'node:child_process'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRclone, type RemoteTarget } from '../../src/main/remote/rclone'
import { tempDir } from '../helpers/audio'

const binary = process.env.RCLONE_BINARY ?? 'rclone'

function localTarget(): RemoteTarget {
  return { remote: ':local', folder: tempDir('lms-remote-') }
}

function cryptTarget(): RemoteTarget {
  const password = execFileSync(binary, ['obscure', 'test-password'])
    .toString()
    .trim()
  const base = tempDir('lms-crypt-')
  return {
    remote: `:crypt,remote='${base}',password='${password}'`,
    folder: 'music',
  }
}

/** A local library folder holding the given files; returns the folder. */
function localTree(files: Record<string, string>): string {
  const root = tempDir('lms-src-')
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
    writeFileSync(path.join(root, relative), content)
  }
  return root
}

describe('rclone remote', () => {
  const rclone = createRclone(binary)

  it('detects hash support per backend', async () => {
    expect((await rclone.capabilities(localTarget())).hashAlgo).toBe('md5')
    expect((await rclone.capabilities(cryptTarget())).hashAlgo).toBeNull()
  })

  it('uploads, verifies with a common hash, lists, moves and deletes', async () => {
    const target = localTarget()
    const root = localTree({ 'A/B/01 x.m4a': 'hello audio' })
    const progress: number[] = []
    const [uploaded] = await rclone.upload(
      target,
      root,
      ['A/B/01 x.m4a'],
      (f) => progress.push(f)
    )
    expect(uploaded.hashAlgo).toBe('md5')
    expect(uploaded.size).toBe(11)
    expect(progress.at(-1)).toBe(1)

    const listed = await rclone.list(target, { hashAlgo: 'md5' })
    expect([...listed.keys()]).toEqual(['A/B/01 x.m4a'])
    expect(listed.get('A/B/01 x.m4a')?.hash).toBe(uploaded.hash)

    await rclone.move(target, 'A/B/01 x.m4a', 'C/01 x.m4a')
    expect(await rclone.stat(target, 'A/B/01 x.m4a', null)).toBeNull()
    expect(await rclone.stat(target, 'C/01 x.m4a', null)).not.toBeNull()

    await rclone.delete(target, 'C/01 x.m4a')
    await rclone.delete(target, 'C/01 x.m4a')
    expect((await rclone.list(target, {})).size).toBe(0)
  })

  it('verifies by downloading when the backend has no hash', async () => {
    const target = cryptTarget()
    const root = localTree({ 'x.m4a': 'crypted audio' })
    const file = path.join(root, 'x.m4a')
    const [uploaded] = await rclone.upload(target, root, ['x.m4a'], () => {})
    expect(uploaded.hashAlgo).toBeNull()
    expect(await rclone.verify(target, file, 'x.m4a')).not.toBeNull()
    writeFileSync(file, 'changed locally!!')
    expect(await rclone.verify(target, file, 'x.m4a')).toBeNull()
  })

  it('uploads files from different folders in one run and verifies each', async () => {
    const target = localTarget()
    const root = localTree({
      'A/B/01 x.m4a': 'audio bytes',
      'A/B/01 x.lrc': '[00:01.00]words',
      'C/02 y.m4a': 'other audio',
    })
    const paths = ['A/B/01 x.m4a', 'A/B/01 x.lrc', 'C/02 y.m4a']
    const uploaded = await rclone.upload(target, root, paths, () => {})
    expect(uploaded.map((item) => item.size)).toEqual([11, 15, 11])
    expect(uploaded.every((item) => item.hash)).toBe(true)
    expect([...(await rclone.list(target, {})).keys()].sort()).toEqual(
      [...paths].sort()
    )
    expect(await rclone.upload(target, root, [], () => {})).toEqual([])
  })

  it('fails the batch when one file does not verify', async () => {
    const target = localTarget()
    const root = localTree({
      'A/01 x.m4a': 'audio bytes',
      'A/01 x.lrc': '[00:01.00]words',
    })
    // rclone skips a remote file with the same size and time, so this stale
    // copy with different bytes survives the copy and must fail verification.
    const lrc = path.join(root, 'A/01 x.lrc')
    const stale = path.join(target.folder, 'A/01 x.lrc')
    mkdirSync(path.dirname(stale), { recursive: true })
    writeFileSync(stale, '[00:01.00]WORDS')
    const time = new Date('2026-01-01T00:00:00Z')
    utimesSync(lrc, time, time)
    utimesSync(stale, time, time)
    await expect(
      rclone.upload(target, root, ['A/01 x.m4a', 'A/01 x.lrc'], () => {})
    ).rejects.toThrow(/verification failed for A\/01 x\.lrc$/)
  })

  it('returns an empty listing for a missing folder and unicode paths in NFC', async () => {
    const target = { remote: ':local', folder: path.join(tempDir(), 'missing') }
    expect((await rclone.list(target, {})).size).toBe(0)
    const real = localTarget()
    mkdirSync(path.join(real.folder, 'Cáfe'), { recursive: true })
    writeFileSync(path.join(real.folder, 'Cáfe', 'a.m4a'), 'x')
    const listed = await rclone.list(real, {})
    expect([...listed.keys()][0]).toBe('Cáfe/a.m4a'.normalize('NFC'))
  })
})
