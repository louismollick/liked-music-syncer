import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ActivityProvider, AppStateProvider } from './lib/app-state'
import { router } from './router'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppStateProvider>
      <ActivityProvider>
        <RouterProvider router={router} />
      </ActivityProvider>
    </AppStateProvider>
  </StrictMode>
)
