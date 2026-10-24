import { describe, expect, it } from 'vitest'
import { ProcessTimeoutError, run } from '../../src/main/platform/process'

describe('run', () => {
  it('kills a process that prints nothing for too long and calls it transient', async () => {
    const started = Date.now()
    const error = await run('sh', ['-c', 'exec sleep 30'], {
      idleTimeoutMs: 100,
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ProcessTimeoutError)
    expect(error).toMatchObject({ kind: 'transient' })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('treats output as activity', async () => {
    const result = await run(
      'sh',
      ['-c', 'for i in 1 2 3 4; do echo tick; sleep 0.15; done'],
      { idleTimeoutMs: 400 }
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('tick\ntick\ntick\ntick\n')
  })

  it('has no idle limit when the timeout is 0', async () => {
    const result = await run('sh', ['-c', 'sleep 0.3; echo done'], {
      idleTimeoutMs: 0,
    })
    expect(result.stdout).toBe('done\n')
  })

  it('escalates an abort to SIGKILL when the process ignores SIGTERM', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const pending = run('sh', ['-c', 'trap "" TERM; exec sleep 30'], {
      signal: controller.signal,
      killGraceMs: 100,
    })
    setTimeout(() => controller.abort(new Error('stop')), 100)
    await expect(pending).rejects.toThrow('stop')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('escalates an idle timeout to SIGKILL too', async () => {
    const started = Date.now()
    await expect(
      run('sh', ['-c', 'trap "" TERM; exec sleep 30'], {
        idleTimeoutMs: 100,
        killGraceMs: 100,
      })
    ).rejects.toBeInstanceOf(ProcessTimeoutError)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  // sh exits at once, but its backgrounded helper keeps stdout open and
  // prints its pid first so the test can check the helper was killed.
  const orphanScript = 'sleep 30 & echo $!; exit 0'
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const waitDead = async (pid: number) => {
    for (let i = 0; i < 100 && alive(pid); i++)
      await new Promise((resolve) => setTimeout(resolve, 50))
    return !alive(pid)
  }

  it('settles an idle timeout after the parent exited while a descendant holds the pipes', async () => {
    let pid = 0
    const started = Date.now()
    const error = await run('sh', ['-c', orphanScript], {
      idleTimeoutMs: 300,
      killGraceMs: 100,
      onLine: (line) => {
        pid = Number(line)
      },
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ProcessTimeoutError)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(await waitDead(pid)).toBe(true)
  })

  it('settles an abort after the parent exited while a descendant holds the pipes', async () => {
    const controller = new AbortController()
    let pid = 0
    const pending = run('sh', ['-c', orphanScript], {
      signal: controller.signal,
      killGraceMs: 100,
      onLine: (line) => {
        pid = Number(line)
      },
    })
    setTimeout(() => controller.abort(new Error('stop')), 300)
    await expect(pending).rejects.toThrow('stop')
    expect(await waitDead(pid)).toBe(true)
  })
})
