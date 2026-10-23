import { describe, expect, it } from 'vitest'
import { isConnectivityError } from '../../src/main/net/connectivity'
import { createHttpClient } from '../../src/main/net/http'
import { ProcessError } from '../../src/main/platform/process'

function processError(stderr: string): ProcessError {
  return new ProcessError('rclone exited with 1', {
    code: 1,
    stdout: '',
    stdoutBytes: Buffer.alloc(0),
    stderr,
  })
}

describe('isConnectivityError', () => {
  it.each([
    'getaddrinfo ENOTFOUND vps.example.com',
    'connect ECONNREFUSED 10.0.0.2:22',
    'connect ETIMEDOUT 10.0.0.2:22',
    'connect ENETUNREACH 10.0.0.2:22',
    'ssh: connect to host vps port 22: Connection refused',
    'connect: no route to host',
    'read tcp 10.0.0.1:5000->10.0.0.2:22: i/o timeout',
    'dial tcp: lookup vps.example.com: no such host',
    'net::ERR_INTERNET_DISCONNECTED',
    'ERROR: Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided, or not known>',
  ])('recognizes %s', (message) => {
    expect(isConnectivityError(new Error(message))).toBe(true)
  })

  it('reads a process error from its stderr, not only its message', () => {
    expect(
      isConnectivityError(
        processError(
          'ERROR : x: Failed to copy: dial tcp 1.2.3.4:22: connect: connection refused'
        )
      )
    ).toBe(true)
  })

  it('follows error causes', () => {
    const cause = Object.assign(new Error('getaddrinfo'), {
      code: 'ENOTFOUND',
    })
    expect(isConnectivityError(new Error('fetch failed', { cause }))).toBe(true)
  })

  it('classifies a failed fetch by the cause the HTTP client reports', async () => {
    const http = createHttpClient(
      async () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('getaddrinfo'), {
            code: 'ENOTFOUND',
          }),
        })
      },
      Date.now,
      async () => {}
    )
    const error = await http
      .json('https://example.test/x', { host: 'lrclib' })
      .catch((caught: unknown) => caught)
    expect(isConnectivityError(error)).toBe(true)
  })

  it.each([
    'Video unavailable',
    'rclone exited with 1: Failed to copy: permission denied',
    'Upload verification failed for a.m4a',
    'HTTP 404',
  ])('leaves %s as a per-track failure', (message) => {
    expect(isConnectivityError(new Error(message))).toBe(false)
  })

  it('ignores things that are not errors', () => {
    expect(isConnectivityError(undefined)).toBe(false)
    expect(isConnectivityError({ message: 'ENOTFOUND' })).toBe(false)
  })
})
