import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRclone, type RemoteTarget } from '../../src/main/remote/rclone'
import { tempDir } from '../helpers/audio'

const binary = process.env.RCLONE_BINARY ?? 'rclone'

function localTarget(): RemoteTarget {
  return { remote: ':local', folder: tempDir('lms-remote-') }
}

function cryptTarget(): RemoteTarget {
  const password = execFileSync(binary, ['obscure', 'test-password']).toString().trim()
  const base = tempDir('lms-crypt-')
  return { remote: `:crypt,remote='${base}',password='${password}'`, folder: 'music' }
}

function localFile(content: string): string {
  const dir = tempDir('lms-src-')
  const file = path.join(dir, 'song.m4a')
  writeFileSync(file, content)
  return file
}

describe('rclone remote', () => {
  const rclone = createRclone(binary)

  it('detects hash support per backend', async () => {
    expect((await rclone.capabilities(localTarget())).hashAlgo).toBe('md5')
    expect((await rclone.capabilities(cryptTarget())).hashAlgo).toBeNull()
  })

  it('uploads, verifies with a common hash, lists, moves and deletes', async () => {
    const target = localTarget()
    const file = localFile('hello audio')
    const progress: number[] = []
    const uploaded = await rclone.upload(target, file, 'A/B/01 x.m4a', (f) => progress.push(f))
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
    const file = localFile('crypted audio')
    const uploaded = await rclone.upload(target, file, 'x.m4a', () => {})
    expect(uploaded.hashAlgo).toBeNull()
    expect(await rclone.verify(target, file, 'x.m4a')).not.toBeNull()
    writeFileSync(file, 'changed locally!!')
    expect(await rclone.verify(target, file, 'x.m4a')).toBeNull()
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
