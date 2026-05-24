import type {
  AppSettingsView,
  AuthStatus,
  CommandResult,
  YtDlpCookiesBrowser,
} from '@shared/contracts'
import type { JSX } from 'react'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { Input } from '../ui/Input'
import { Select } from '../ui/Select'
import { SettingsSection } from './SettingsSection'

const BROWSERS: YtDlpCookiesBrowser[] = [
  'brave',
  'chrome',
  'chromium',
  'edge',
  'firefox',
  'opera',
  'safari',
  'vivaldi',
  'whale',
]

interface Props {
  settings: AppSettingsView
  authStatus: AuthStatus
  onChange: (next: Partial<AppSettingsView>) => void
  onSave: () => void
  onAction: (action: Promise<CommandResult>) => void
}

export function SettingsView({
  settings,
  authStatus,
  onChange,
  onSave,
  onAction,
}: Props): JSX.Element {
  const captureAuth = async () => {
    const result = await window.api.auth.captureBrowserAuth(
      settings.ytDlpCookiesBrowser
    )
    onAction(Promise.resolve(result))
  }

  const pickDirectory = async () => {
    const picked = await window.api.settings.pickOutputDirectory()
    if (picked) onChange({ outputDirectory: picked })
  }

  return (
    <div className="p-6 max-w-2xl">
      <h2 className="text-xl font-semibold text-text-primary mb-6">Settings</h2>

      <SettingsSection title="Authentication">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-text-primary font-medium">
              YouTube Music Auth
            </p>
            <p className="text-xs text-text-muted mt-0.5">
              {authStatus.isAuthenticated
                ? 'Authenticated via browser headers'
                : authStatus.lastError
                  ? `Error: ${authStatus.lastError}`
                  : 'Not authenticated'}
            </p>
          </div>
          <div
            className={`w-2 h-2 rounded-full flex-shrink-0 ${authStatus.isAuthenticated ? 'bg-success' : 'bg-error'}`}
          />
        </div>
        <div className="flex gap-2">
          <div className="flex-1">
            <Select
              value={settings.ytDlpCookiesBrowser}
              onChange={(e) =>
                onChange({
                  ytDlpCookiesBrowser: e.target.value as YtDlpCookiesBrowser,
                })
              }
            >
              {BROWSERS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </Select>
          </div>
          <Button variant="primary" onClick={captureAuth}>
            Capture Auth
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection title="Output">
        <div className="flex gap-2">
          <div className="flex-1">
            <Input
              label="Output Directory"
              value={settings.outputDirectory}
              placeholder="/path/to/music"
              onChange={(e) => onChange({ outputDirectory: e.target.value })}
            />
          </div>
          <div className="flex items-end">
            <Button onClick={pickDirectory}>Browse</Button>
          </div>
        </div>
        <Input
          label="Folder Template"
          value={settings.folderTemplate}
          onChange={(e) => onChange({ folderTemplate: e.target.value })}
        />
        <Input
          label="File Template"
          value={settings.fileTemplate}
          onChange={(e) => onChange({ fileTemplate: e.target.value })}
        />
      </SettingsSection>

      <SettingsSection title="Remote">
        <Input
          label="rclone Remote"
          value={settings.rcloneRemote}
          placeholder="remote:"
          onChange={(e) => onChange({ rcloneRemote: e.target.value })}
        />
        <Input
          label="Remote Music Root"
          value={settings.remoteMusicRoot}
          placeholder="/music"
          onChange={(e) => onChange({ remoteMusicRoot: e.target.value })}
        />
        <Checkbox
          label="Remote copy enabled"
          checked={settings.remoteCopyEnabled}
          onChange={(e) => onChange({ remoteCopyEnabled: e.target.checked })}
        />
      </SettingsSection>

      <SettingsSection title="Lyrics">
        <Input
          label="Lyrics API Base URL"
          value={settings.lyricsApiBaseUrl}
          placeholder="https://lrclib.net"
          onChange={(e) => onChange({ lyricsApiBaseUrl: e.target.value })}
        />
        <Checkbox
          label="Embed unsynced lyrics"
          checked={settings.embedUnsyncedLyrics}
          onChange={(e) => onChange({ embedUnsyncedLyrics: e.target.checked })}
        />
        <Checkbox
          label="Write .lrc sidecar file"
          checked={settings.writeLrcSidecar}
          onChange={(e) => onChange({ writeLrcSidecar: e.target.checked })}
        />
      </SettingsSection>

      <SettingsSection title="Preferences">
        <Checkbox
          label="Auto-approve modifications and deletions"
          checked={settings.autoApproveChanges}
          onChange={(e) => onChange({ autoApproveChanges: e.target.checked })}
        />
      </SettingsSection>

      <SettingsSection title="Maintenance">
        <div className="flex gap-2">
          <Button onClick={() => onAction(window.api.settings.testRemote())}>
            Test Remote
          </Button>
          <Button
            variant="danger"
            onClick={() => onAction(window.api.sync.clearSyncData())}
          >
            Clear Sync Data
          </Button>
        </div>
      </SettingsSection>

      <div className="sticky bottom-0 pt-4">
        <Button variant="primary" onClick={onSave}>
          Save Settings
        </Button>
      </div>
    </div>
  )
}
