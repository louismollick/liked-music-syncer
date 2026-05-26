import { createHashHistory, createRouter } from '@tanstack/react-router'
import { indexRoute } from './routes/index'
import { libraryRoute } from './routes/library'
import { rootRoute } from './routes/root'
import { settingsRoute } from './routes/settings'
import { syncRoute } from './routes/sync'

const routeTree = rootRoute.addChildren([
  indexRoute,
  libraryRoute,
  syncRoute,
  settingsRoute,
])

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
