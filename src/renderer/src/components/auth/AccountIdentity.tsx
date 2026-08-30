import type { YouTubeMusicAccountView } from '@shared/contracts'
import type { JSX } from 'react'
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar'
import { Spinner } from '../ui/spinner'

export function AccountAvatar({
  account,
  className = 'size-9',
}: {
  account: YouTubeMusicAccountView
  className?: string
}): JSX.Element {
  return (
    <Avatar className={`${className} rounded-lg after:rounded-lg`}>
      {account.imageUrl ? (
        <AvatarImage src={account.imageUrl} className="rounded-lg" />
      ) : null}
      <AvatarFallback className="rounded-lg">
        {account.displayName.slice(0, 2).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  )
}

export function AccountCount({
  account,
}: {
  account: YouTubeMusicAccountView
}): JSX.Element | null {
  if (account.likedSongCountState === 'loading') return <Spinner />
  if (
    account.likedSongCountState !== 'loaded' ||
    account.likedSongCount == null
  )
    return null
  return (
    <span className="block text-xs text-text-muted">
      {account.likedSongCount.toLocaleString()} liked{' '}
      {account.likedSongCount === 1 ? 'song' : 'songs'}
    </span>
  )
}

export function AccountIdentity({
  account,
  avatarClassName,
  switching = false,
}: {
  account: YouTubeMusicAccountView
  avatarClassName?: string
  switching?: boolean
}): JSX.Element {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <AccountAvatar account={account} className={avatarClassName} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-text-primary">
          {account.displayName}
        </span>
        <span className="block truncate text-xs text-text-muted">
          {account.handle ?? 'YouTube Music'}
        </span>
        <AccountCount account={account} />
      </span>
      {switching ? <Spinner /> : null}
    </span>
  )
}
