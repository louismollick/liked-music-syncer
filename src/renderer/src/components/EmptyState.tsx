import { FolderOpen, LogIn } from 'lucide-react'
import { invoke } from '../lib/api'
import { useAppState } from '../lib/app-state'
import { Button } from './ui/Button'

/** Shown in the Library until the user is signed in and has chosen a folder. */
export function useSetupNeeded(): boolean {
  const { session, settings } = useAppState()
  if (!session || !settings) return false
  return session.state !== 'signed_in' || !settings.libraryFolder
}

export function SetupEmptyState() {
  const { session, settings, updateSettings } = useAppState()
  const signedIn = session?.state === 'signed_in'
  const hasFolder = Boolean(settings?.libraryFolder)
  return (
    <div className="h-full flex items-center justify-center">
      <div className="max-w-sm text-center space-y-5 fade-in">
        <div>
          <div className="text-xl font-semibold tracking-tight">
            Your liked songs, as files you own
          </div>
          <div className="mt-2 text-[13px] text-zinc-400">
            Sign in to YouTube Music and choose a folder. Liked songs download
            there, tagged and ready for Navidrome, Plex or any music app.
          </div>
        </div>
        <div className="flex flex-col gap-2 items-stretch">
          <Button
            variant={signedIn ? 'default' : 'primary'}
            disabled={signedIn}
            onClick={() => void invoke('session:signIn')}
          >
            <LogIn className="w-4 h-4" />{' '}
            {signedIn
              ? 'Signed in to YouTube Music'
              : 'Sign in to YouTube Music'}
          </Button>
          <Button
            variant={signedIn && !hasFolder ? 'primary' : 'default'}
            onClick={async () => {
              const folder = await invoke('settings:chooseFolder')
              if (folder) await updateSettings({ libraryFolder: folder })
            }}
          >
            <FolderOpen className="w-4 h-4" />{' '}
            {hasFolder ? settings?.libraryFolder : 'Choose a folder'}
          </Button>
        </div>
      </div>
    </div>
  )
}
