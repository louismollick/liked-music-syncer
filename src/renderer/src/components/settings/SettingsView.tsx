import type {
  AppSettingsView,
  AuthSessionView,
  CommandResult,
} from '@shared/contracts'
import type { JSX } from 'react'
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { Input } from '../ui/Input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import { Spinner } from '../ui/spinner'
import { SettingsSection } from './SettingsSection'

interface Props {
  settings: AppSettingsView
  authSession: AuthSessionView
  onChange: (next: Partial<AppSettingsView>) => void
  onRefreshAuth: () => void
  onSelectSource: (sourceId: string) => void
  onSelectAccount: (accountKey: string) => void
  onLoadAccountCounts: () => void
  switchingAccountKey: string | null
  accountSwitchError: string | null
  onAction: (action: Promise<CommandResult>) => void
}

export function SettingsView({
  settings,
  authSession,
  onChange,
  onRefreshAuth,
  onSelectSource,
  onSelectAccount,
  onLoadAccountCounts,
  switchingAccountKey,
  accountSwitchError,
  onAction,
}: Props): JSX.Element {
  const browserItems = authSession.sources.map((source) => ({
    label: `${source.browserName}${source.profileName ? ` (${source.profileName})` : ''}`,
    value: source.id,
  }))
  const selectedBrowser = authSession.sources.find(
    (source) => source.id === authSession.selectedSourceId
  )
  const selectedBrowserLabel = selectedBrowser
    ? `${selectedBrowser.browserName}${selectedBrowser.profileName ? ` (${selectedBrowser.profileName})` : ''}`
    : undefined
  const accountItems = authSession.accounts.map((account) => ({
    label: `${account.displayName}${account.handle ? ` ${account.handle}` : ''}`,
    value: account.key,
  }))
  const selectedAccount =
    authSession.accounts.find(
      (account) => account.key === authSession.selectedAccountKey
    ) ?? authSession.activeAccount

  const accountRow = (account: NonNullable<typeof selectedAccount>) => (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <Avatar className="size-9 rounded-lg after:rounded-lg">
        {account.imageUrl ? (
          <AvatarImage src={account.imageUrl} className="rounded-lg" />
        ) : null}
        <AvatarFallback className="rounded-lg">
          {account.displayName.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-text-primary">
          {account.displayName}
        </span>
        <span className="block truncate text-xs text-text-muted">
          {account.handle ?? 'YouTube Music'}
        </span>
        {account.likedSongCountState === 'loading' ? (
          <Spinner />
        ) : account.likedSongCountState === 'loaded' &&
          account.likedSongCount != null ? (
          <span className="block text-xs text-text-muted">
            {account.likedSongCount.toLocaleString()} liked{' '}
            {account.likedSongCount === 1 ? 'song' : 'songs'}
          </span>
        ) : null}
      </span>
      {switchingAccountKey === account.key ? <Spinner /> : null}
    </span>
  )

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
              {authSession.state === 'signed_in'
                ? `Signed in as ${authSession.activeAccount?.displayName ?? 'YouTube Music'}`
                : authSession.state === 'signed_out'
                  ? 'Signed out'
                  : (authSession.issue?.message ??
                    'Checking installed browsers')}
            </p>
          </div>
          <div
            className={`w-2 h-2 rounded-full flex-shrink-0 ${authSession.state === 'signed_in' ? 'bg-success' : 'bg-error'}`}
          />
        </div>
        <div className="flex gap-2">
          <div className="flex-1">
            <Select
              items={browserItems}
              value={authSession.selectedSourceId ?? undefined}
              onValueChange={(value) => value && onSelectSource(value)}
              onOpenChange={(open) => {
                if (open) onRefreshAuth()
              }}
              disabled={Boolean(authSession.switchingDisabledReason)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a browser">
                  {selectedBrowserLabel}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {authSession.sources.map((source) => (
                    <SelectItem key={source.id} value={source.id}>
                      <span className="flex items-center gap-2">
                        {source.status === 'checking' ? (
                          <Spinner />
                        ) : (
                          <span
                            className={`size-2 rounded-full ${source.status === 'signed_in' ? 'bg-success' : source.status === 'unchecked' ? 'bg-text-muted' : 'bg-error'}`}
                          />
                        )}
                        <span>
                          {source.browserName}
                          {source.profileName ? ` (${source.profileName})` : ''}
                        </span>
                        <span className="text-text-muted">
                          {source.status === 'signed_in'
                            ? 'Signed in'
                            : source.status === 'signed_out'
                              ? 'Signed out'
                              : source.status === 'issue'
                                ? 'Issue getting auth'
                                : 'Checking'}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          {authSession.state === 'signed_out' ? (
            <Button
              variant="primary"
              onClick={() => {
                void window.api.auth.openSignIn()
              }}
            >
              Open YouTube Music
            </Button>
          ) : (
            <Button onClick={onRefreshAuth}>Retry</Button>
          )}
        </div>
        {selectedAccount ? (
          <div className="flex flex-col gap-1">
            <Select
              items={accountItems}
              value={authSession.selectedAccountKey ?? undefined}
              onValueChange={(value) => value && onSelectAccount(value)}
              onOpenChange={(open) => {
                if (open) onLoadAccountCounts()
              }}
              disabled={
                Boolean(authSession.switchingDisabledReason) ||
                switchingAccountKey !== null
              }
            >
              <SelectTrigger className="h-auto min-h-12 w-full">
                <SelectValue placeholder="Select an account">
                  {accountRow(selectedAccount)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent
                alignItemWithTrigger={false}
                className="min-w-(--anchor-width)"
              >
                <SelectGroup>
                  {authSession.accounts.map((account) => (
                    <SelectItem
                      key={account.key}
                      value={account.key}
                      className="py-2"
                    >
                      {accountRow(account)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {accountSwitchError ? (
              <p className="text-xs text-error">{accountSwitchError}</p>
            ) : null}
          </div>
        ) : null}
        {authSession.issue ? (
          <p className="text-sm text-error">{authSession.issue.recovery}</p>
        ) : null}
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

      <SettingsSection title="Maintenance">
        <div className="flex gap-2">
          <Button onClick={() => onAction(window.api.library.refreshIndex())}>
            Refresh Library
          </Button>
          <Button onClick={() => onAction(window.api.settings.testRemote())}>
            Test Remote
          </Button>
          <Button
            variant="danger"
            onClick={() => onAction(window.api.sync.clearSyncData())}
          >
            Clear Sync Data
          </Button>
          <Button
            variant="danger"
            onClick={() => onAction(window.api.library.clearArtistImageCache())}
          >
            Clear Artist Image Cache
          </Button>
        </div>
      </SettingsSection>
    </div>
  )
}
