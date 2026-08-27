import type {
  AuthStatus,
  BrowserAuthCaptureResult,
  CommandResult,
  YtDlpCookiesBrowser,
} from '@shared/contracts'

interface CaptureBrowserAuthOptions {
  browser: YtDlpCookiesBrowser
  capture: (browser: YtDlpCookiesBrowser) => Promise<BrowserAuthCaptureResult>
  onAction: (action: Promise<CommandResult>) => void
  onAuthStatusChange: (authStatus: AuthStatus) => void
}

export async function runBrowserAuthCapture({
  browser,
  capture,
  onAction,
  onAuthStatusChange,
}: CaptureBrowserAuthOptions): Promise<void> {
  const result = await capture(browser)
  onAuthStatusChange(result.authStatus)
  onAction(Promise.resolve(result))
}
