import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/base.css'
import { App } from './App'
import { startUpdates } from './lib/updates'

startUpdates()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
