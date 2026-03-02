import { useEffect, useState } from 'react'
import { GITHUB_GRAPHQL_ENDPOINT } from './config/env'
import './App.css'

const DASHBOARD_SECTIONS = ['Commits', 'Pull Requests', 'Issues', 'Cycle Time']
const TOKEN_STORAGE_KEY = 'gitTelemetry.githubToken'
const VIEWER_QUERY = `
  query ViewerValidation {
    viewer {
      login
    }
  }
`

type TokenValidationState = 'idle' | 'validating' | 'valid' | 'invalid' | 'error'

type TokenValidationStatus = {
  state: TokenValidationState
  message: string
  viewerLogin?: string
}

function readTokenFromStorage(): string {
  if (typeof window === 'undefined') {
    return ''
  }

  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function App() {
  const [token, setToken] = useState<string>(() => readTokenFromStorage())
  const [persistToken, setPersistToken] = useState<boolean>(() => readTokenFromStorage().length > 0)
  const [tokenStatus, setTokenStatus] = useState<TokenValidationStatus>({
    state: 'idle',
    message: 'Token not validated yet.',
  })

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    try {
      if (!persistToken || token.trim().length === 0) {
        localStorage.removeItem(TOKEN_STORAGE_KEY)
        return
      }

      localStorage.setItem(TOKEN_STORAGE_KEY, token.trim())
    } catch {
      // Ignore storage write failures; token still remains in memory for this session.
    }
  }, [persistToken, token])

  async function handleValidateToken() {
    const trimmedToken = token.trim()
    if (trimmedToken.length === 0) {
      setTokenStatus({
        state: 'invalid',
        message: 'Enter a GitHub token before validation.',
      })
      return
    }

    setTokenStatus({
      state: 'validating',
      message: 'Validating token against GitHub GraphQL...',
    })

    try {
      const response = await fetch(GITHUB_GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${trimmedToken}`,
        },
        body: JSON.stringify({ query: VIEWER_QUERY }),
      })

      const payload = (await response.json().catch(() => null)) as {
        data?: { viewer?: { login?: string } }
        errors?: Array<{ message?: string }>
      } | null

      const errorMessage =
        payload?.errors && payload.errors.length > 0 ? (payload.errors[0]?.message ?? '') : ''

      if (!response.ok) {
        if (response.status === 401 || errorMessage.toLowerCase().includes('bad credentials')) {
          setTokenStatus({
            state: 'invalid',
            message: 'Token is invalid or missing required permissions.',
          })
          return
        }

        setTokenStatus({
          state: 'error',
          message: `Validation failed with HTTP ${response.status}.`,
        })
        return
      }

      if (errorMessage.length > 0) {
        if (errorMessage.toLowerCase().includes('bad credentials')) {
          setTokenStatus({
            state: 'invalid',
            message: 'Token is invalid or missing required permissions.',
          })
          return
        }

        setTokenStatus({
          state: 'error',
          message: errorMessage,
        })
        return
      }

      const viewerLogin = payload?.data?.viewer?.login
      if (!viewerLogin) {
        setTokenStatus({
          state: 'error',
          message: 'Validation response did not include viewer login.',
        })
        return
      }

      setTokenStatus({
        state: 'valid',
        message: `Token is valid for @${viewerLogin}.`,
        viewerLogin,
      })
    } catch {
      setTokenStatus({
        state: 'error',
        message: 'Network error while validating token.',
      })
    }
  }

  function handleClearToken() {
    setToken('')
    setTokenStatus({
      state: 'idle',
      message: 'Token cleared.',
    })

    if (typeof window === 'undefined') {
      return
    }

    try {
      localStorage.removeItem(TOKEN_STORAGE_KEY)
    } catch {
      setTokenStatus({
        state: 'error',
        message: 'Token cleared from state, but localStorage could not be updated.',
      })
    }
  }

  const isValidating = tokenStatus.state === 'validating'
  const tokenStatusClassName = `token-status token-status--${tokenStatus.state}`

  return (
    <div className="app-shell">
      <header className="setup-layout">
        <div className="panel brand-panel">
          <div className="brand">
            <img src="/logo.png" alt="Git Activity Analyzer logo" className="brand-logo" />
            <div>
              <h1>Git Activity Analyzer</h1>
              <p>Analyze multi-repo GitHub activity in one run.</p>
            </div>
          </div>
        </div>

        <div className="panel auth-panel">
          <h2>Authentication</h2>
          <div className="control-grid control-grid--single">
            <label className="control-field control-field--full">
              <span>GitHub Token</span>
              <input
                type="password"
                placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                value={token}
                onChange={(event) => {
                  setToken(event.target.value)
                  setTokenStatus({
                    state: 'idle',
                    message: 'Token changed. Re-validate before running analysis.',
                  })
                }}
              />
            </label>
            <label className="remember-toggle">
              <input
                type="checkbox"
                checked={persistToken}
                onChange={(event) => setPersistToken(event.target.checked)}
              />
              Remember token on this device
            </label>
            <div className="action-row">
              <button type="button" onClick={handleValidateToken} disabled={isValidating}>
                {isValidating ? 'Validating...' : 'Validate Token'}
              </button>
              <button type="button" onClick={handleClearToken} disabled={isValidating || token.length === 0}>
                Clear Token
              </button>
            </div>
            <p className={tokenStatusClassName}>{tokenStatus.message}</p>
          </div>
        </div>

        <div className="panel setup-panel">
          <h2>Analysis Scope</h2>
          <div className="control-grid">
            <label className="control-field">
              <span>Time Range</span>
              <select defaultValue="365">
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
                <option value="365">Last 365 days</option>
                <option value="custom">Custom range</option>
              </select>
            </label>
            <label className="control-field control-field--full">
              <span>Repository Selection</span>
              <input type="text" placeholder="Search repositories or add owner/repo" />
            </label>
            <div className="action-row">
              <button type="button">Discover Repos</button>
              <button type="button" className="button-primary">
                Run Analysis
              </button>
            </div>
          </div>
        </div>
      </header>

      <section className="panel status-panel">
        <div>
          <h2>Fetch Status</h2>
          <p>Waiting for analysis run.</p>
        </div>
        <p className="endpoint-note">GraphQL endpoint: {GITHUB_GRAPHQL_ENDPOINT}</p>
      </section>

      <main className="dashboard">
        {DASHBOARD_SECTIONS.map((section) => (
          <section className="panel dashboard-section" key={section}>
            <h2>{section}</h2>
            <p>Charts and controls will be added in upcoming checkpoints.</p>
            <div className="chart-placeholder">No data yet</div>
          </section>
        ))}
      </main>
    </div>
  )
}

export default App
