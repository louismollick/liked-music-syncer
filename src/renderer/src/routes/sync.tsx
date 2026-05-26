import { createRoute } from '@tanstack/react-router'
import type { JSX } from 'react'
import { useAppState } from '../App'
import { SyncView } from '../components/sync/SyncView'
import { rootRoute } from './root'

export const syncRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'sync',
  component: SyncRouteComponent,
})

export function SyncRouteComponent(): JSX.Element {
  const { snapshot, runAction } = useAppState()
  return <SyncView snapshot={snapshot} onAction={runAction} />
}
