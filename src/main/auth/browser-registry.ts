import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface InstalledAuthSource {
  id: string
  browserName: string
  applicationPath: string
  profileName: string | null
  cookieBackend: string
}

interface BrowserDefinition {
  id: string
  bundleIds: string[]
  browserName: string
  cookieBackend: string
}

// Only list browsers whose authenticated cookies the worker can read reliably.
// Helium is intentionally omitted: it stores Chromium cookies that yt-dlp can
// locate but cannot decrypt, so presenting it would misreport that as sign-out.
export const BROWSER_REGISTRY: BrowserDefinition[] = [
  {
    id: 'chrome',
    bundleIds: ['com.google.Chrome'],
    browserName: 'Google Chrome',
    cookieBackend: 'chrome',
  },
  {
    id: 'safari',
    bundleIds: ['com.apple.Safari'],
    browserName: 'Safari',
    cookieBackend: 'safari',
  },
  {
    id: 'firefox',
    bundleIds: ['org.mozilla.firefox'],
    browserName: 'Firefox',
    cookieBackend: 'firefox',
  },
  {
    id: 'brave',
    bundleIds: ['com.brave.Browser'],
    browserName: 'Brave',
    cookieBackend: 'brave',
  },
  {
    id: 'edge',
    bundleIds: ['com.microsoft.edgemac'],
    browserName: 'Microsoft Edge',
    cookieBackend: 'edge',
  },
  {
    id: 'vivaldi',
    bundleIds: ['com.vivaldi.Vivaldi'],
    browserName: 'Vivaldi',
    cookieBackend: 'vivaldi',
  },
  {
    id: 'opera',
    bundleIds: ['com.operasoftware.Opera'],
    browserName: 'Opera',
    cookieBackend: 'opera',
  },
  {
    id: 'zen',
    bundleIds: ['app.zen-browser.zen'],
    browserName: 'Zen',
    cookieBackend: 'zen',
  },
]

async function profileName(
  source: InstalledAuthSource
): Promise<string | null> {
  if (!['chrome', 'brave', 'edge', 'vivaldi', 'opera'].includes(source.id))
    return null
  const roots: Record<string, string> = {
    chrome: 'Google/Chrome',
    brave: 'BraveSoftware/Brave-Browser',
    edge: 'Microsoft Edge',
    vivaldi: 'Vivaldi',
    opera: 'com.operasoftware.Opera',
  }
  try {
    const state = JSON.parse(
      await readFile(
        path.join(
          process.env.HOME ?? '',
          'Library/Application Support',
          roots[source.id],
          'Local State'
        ),
        'utf8'
      )
    ) as { profile?: { last_used?: string } }
    return state.profile?.last_used && state.profile.last_used !== 'Default'
      ? state.profile.last_used
      : null
  } catch {
    return null
  }
}

export async function discoverInstalledBrowsers(): Promise<
  InstalledAuthSource[]
> {
  if (process.platform !== 'darwin') return []
  const bundleIds = BROWSER_REGISTRY.flatMap(
    (definition) => definition.bundleIds
  )
  let applicationPaths: Record<string, string | null> = {}
  try {
    const script = `
ObjC.import('AppKit')
const bundleIds = ${JSON.stringify(bundleIds)}
JSON.stringify(Object.fromEntries(bundleIds.map((bundleId) => {
  const appPath = $.NSWorkspace.sharedWorkspace.absolutePathForAppBundleWithIdentifier(bundleId)
  return [bundleId, appPath ? ObjC.unwrap(appPath) : null]
})))`
    const { stdout } = await execFileAsync(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', script],
      { timeout: 5_000 }
    )
    applicationPaths = JSON.parse(stdout) as Record<string, string | null>
  } catch {
    return []
  }
  const found: InstalledAuthSource[] = []
  for (const definition of BROWSER_REGISTRY) {
    const applicationPath =
      definition.bundleIds
        .map((bundleId) => applicationPaths[bundleId])
        .find((item): item is string => Boolean(item)) ?? null
    if (!applicationPath) continue
    try {
      await access(applicationPath)
    } catch {
      continue
    }
    const source: InstalledAuthSource = {
      id: definition.id,
      browserName: definition.browserName,
      applicationPath,
      profileName: null,
      cookieBackend: definition.cookieBackend,
    }
    source.profileName = await profileName(source)
    found.push(source)
  }
  return found
}
