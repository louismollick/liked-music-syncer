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
  {
    id: 'helium',
    bundleIds: ['net.imput.helium'],
    browserName: 'Helium',
    cookieBackend: 'helium',
  },
]

async function profileName(
  source: InstalledAuthSource
): Promise<string | null> {
  if (
    !['chrome', 'brave', 'edge', 'vivaldi', 'opera', 'helium'].includes(
      source.id
    )
  )
    return null
  const roots: Record<string, string> = {
    chrome: 'Google/Chrome',
    brave: 'BraveSoftware/Brave-Browser',
    edge: 'Microsoft Edge',
    vivaldi: 'Vivaldi',
    opera: 'com.operasoftware.Opera',
    helium: 'net.imput.helium',
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
  const found: InstalledAuthSource[] = []
  for (const definition of BROWSER_REGISTRY) {
    let applicationPath: string | null = null
    for (const bundleId of definition.bundleIds) {
      try {
        const { stdout } = await execFileAsync('/usr/bin/mdfind', [
          `kMDItemCFBundleIdentifier == "${bundleId}"`,
        ])
        applicationPath =
          stdout.split('\n').find((item) => item.endsWith('.app')) ?? null
      } catch {}
      if (applicationPath) break
    }
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
