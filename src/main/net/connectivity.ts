import { ProcessError } from '../platform/process'

/**
 * Messages that mean the network or the remote host is unreachable, as opposed
 * to something wrong with one track. Covers Node errors (fetch, sockets),
 * rclone/ssh (Go) errors, yt-dlp (Python) errors and Chromium net errors.
 */
const CONNECTIVITY =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN|connection refused|no route to host|i\/o timeout|dial tcp|no such host|network is unreachable|could not resolve host|nodename nor servname|temporary failure in name resolution|getaddrinfo|net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_REFUSED|CONNECTION_TIMED_OUT|ADDRESS_UNREACHABLE|NETWORK_CHANGED)/i

/** How much of a child's stderr to scan; earlier lines may be unrelated retries. */
const STDERR_TAIL = 2_000

/** True when the error says the network or the remote host cannot be reached. */
export function isConnectivityError(error: unknown): boolean {
  for (
    let current: unknown = error, depth = 0;
    current && depth < 4;
    depth += 1
  ) {
    if (typeof current === 'string') return CONNECTIVITY.test(current)
    if (!(current instanceof Error)) return false
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && CONNECTIVITY.test(code)) return true
    if (CONNECTIVITY.test(current.message)) return true
    if (
      current instanceof ProcessError &&
      CONNECTIVITY.test(current.result.stderr.slice(-STDERR_TAIL))
    )
      return true
    current = current.cause
  }
  return false
}
