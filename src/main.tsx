import { StrictMode, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import '@capra/theme/base.css'
import '@capra/core/styles.css'
import '@capra/icons/styles.css'
import App from './App'
import { installThemeBridge, type HostTheme } from './host-theme'
import './App.css'

// Until the shell posts CRIBL_APP_LAYOUT, follow the first-paint hint it sets on the iframe.
let theme: HostTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
document.body.classList.toggle('dark', theme === 'dark')
const listeners = new Set<() => void>()
installThemeBridge((next) => {
  theme = next
  listeners.forEach((notify) => notify())
})
const subscribe = (notify: () => void) => {
  listeners.add(notify)
  return () => listeners.delete(notify)
}

function Root() {
  return <App theme={useSyncExternalStore(subscribe, () => theme)} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
