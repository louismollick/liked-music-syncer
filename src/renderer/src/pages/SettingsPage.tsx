import { ChevronDown, FolderOpen, LogIn, LogOut } from 'lucide-react'
import { Artwork } from '../components/ui/Artwork'
import { Button } from '../components/ui/Button'
import { Menu } from '../components/ui/Chip'
import { Switch } from '../components/ui/Switch'
import { TextInput } from '../components/ui/TextInput'
import { invoke } from '../lib/api'
import { useAppState } from '../lib/app-state'

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="pt-8 pb-1 text-[11px] uppercase tracking-wider text-zinc-500 border-b border-line">
      {children}
    </h2>
  )
}

function Row({
  label,
  help,
  children,
}: {
  label: string
  help?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[200px_1fr] gap-6 py-4 border-b border-line">
      <div>
        <div className="text-[13px]">{label}</div>
        {help && <div className="text-[11px] text-zinc-500 mt-0.5">{help}</div>}
      </div>
      <div className="flex items-center gap-2 min-w-0">{children}</div>
    </div>
  )
}

export function SettingsPage() {
  const { settings, session, updateSettings } = useAppState()
  if (!settings || !session) return null
  const account = session.accounts.find(
    (a) => a.id === session.selectedAccountId
  )
  const others = session.accounts.filter(
    (a) => a.id !== session.selectedAccountId
  )
  return (
    <div className="h-full overflow-y-auto scroll-thin">
      <div className="p-6 max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

        <Heading>YouTube Music</Heading>
        <Row
          label="Account"
          help={
            session.state === 'signed_in'
              ? 'Signed in inside the app'
              : (session.message ?? 'Sign in to sync your liked songs')
          }
        >
          {account ? (
            <>
              <Artwork
                src={account.photoUrl}
                label={account.name}
                kind="artist"
                className="w-7 h-7"
              />
              <div className="min-w-0 mr-auto">
                <div className="text-[13px] truncate">{account.name}</div>
                {account.handle && (
                  <div className="text-[11px] text-zinc-500 truncate">
                    {account.handle}
                  </div>
                )}
              </div>
              {others.length > 0 && (
                <Menu
                  align="right"
                  sections={[
                    {
                      title: 'Switch to',
                      options: others.map((a) => ({
                        label: a.name,
                        hint: a.handle ?? undefined,
                        onSelect: () =>
                          void invoke('session:selectAccount', a.id).catch(
                            (e) => alert(e.message)
                          ),
                      })),
                    },
                  ]}
                  trigger={() => (
                    <Button>
                      Switch account <ChevronDown className="w-3.5 h-3.5" />
                    </Button>
                  )}
                />
              )}
              <Button onClick={() => void invoke('session:signOut')}>
                <LogOut className="w-3.5 h-3.5" /> Sign out
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              onClick={() => void invoke('session:signIn')}
            >
              <LogIn className="w-3.5 h-3.5" /> Sign in to YouTube Music
            </Button>
          )}
        </Row>

        <Heading>Library</Heading>
        <Row label="Folder" help="Album Artist / Album / 01 Title.m4a">
          <TextInput
            value={settings.libraryFolder}
            placeholder="Choose a folder"
            mono
            onCommit={(v) => void updateSettings({ libraryFolder: v })}
          />
          <Button
            onClick={async () => {
              const folder = await invoke('settings:chooseFolder')
              if (folder) await updateSettings({ libraryFolder: folder })
            }}
          >
            <FolderOpen className="w-3.5 h-3.5" /> Choose…
          </Button>
        </Row>

        <Heading>Remote</Heading>
        <Row
          label="Upload to remote"
          help="New and changed songs upload automatically"
        >
          <Switch
            checked={settings.remoteEnabled}
            onChange={(v) => void updateSettings({ remoteEnabled: v })}
          />
        </Row>
        <Row
          label="rclone remote"
          help="The name of a remote in your rclone config"
        >
          <TextInput
            value={settings.rcloneRemote}
            placeholder="e.g. vps"
            onCommit={(v) => void updateSettings({ rcloneRemote: v })}
          />
        </Row>
        <Row label="Remote folder">
          <TextInput
            value={settings.remoteFolder}
            placeholder="/home/me/music"
            mono
            onCommit={(v) => void updateSettings({ remoteFolder: v })}
          />
        </Row>

        <Heading>Lyrics</Heading>
        <Row label="Find lyrics" help="Off skips all lyrics lookups">
          <Switch
            checked={settings.lyricsEnabled}
            onChange={(v) => void updateSettings({ lyricsEnabled: v })}
          />
        </Row>
        <Row
          label="Spotify lyrics server"
          help="Optional. Tried first, then YouTube Music, then LRCLIB"
        >
          <TextInput
            value={settings.lyricsServerUrl}
            placeholder="https://…"
            onCommit={(v) => void updateSettings({ lyricsServerUrl: v })}
          />
        </Row>
      </div>
    </div>
  )
}
