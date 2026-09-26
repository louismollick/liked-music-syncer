import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppStateProvider } from './lib/app-state'
import { router } from './router'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppStateProvider>
      <RouterProvider router={router} />
    </AppStateProvider>
  </StrictMode>
)
