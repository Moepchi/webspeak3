import './storageFallback'
import { StrictMode, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/greenteaspeak.css'
import './App.css'
import { LanguageProvider, useT } from './i18n'
import { discardVault, hasVault, unlockVault } from './vault'

const root = createRoot(document.getElementById('root')!)

// App reads its stored identities/favorites while loading, so it's imported only after the vault is open.
async function start() {
  const { default: App } = await import('./App.tsx')
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

function Unlock() {
  const t = useT()
  const [password, setPassword] = useState('')
  const [wrong, setWrong] = useState(false)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    if (await unlockVault(password)) return void start()
    setBusy(false)
    setWrong(true)
  }
  return (
    <div className="ts-dialog-backdrop">
      <form className="ts-dialog ts-vault-dialog" onSubmit={submit}>
        <h3>{t('vault.title')}</h3>
        <p>{t('vault.prompt')}</p>
        <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        {wrong && <p className="ts-vault-wrong">{t('vault.wrong')}</p>}
        <div className="ts-dialog-buttons">
          <button
            type="button"
            onClick={() => {
              if (!window.confirm(t('vault.forgotConfirm'))) return
              discardVault()
              void start()
            }}
          >
            {t('vault.forgot')}
          </button>
          <button type="submit" disabled={busy || !password}>
            {t('vault.unlock')}
          </button>
        </div>
      </form>
    </div>
  )
}

if (hasVault())
  root.render(
    <LanguageProvider>
      <Unlock />
    </LanguageProvider>,
  )
else void start()
