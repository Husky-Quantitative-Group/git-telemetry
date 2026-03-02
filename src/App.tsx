import { GITHUB_GRAPHQL_ENDPOINT } from './config/env'
import './App.css'

const DASHBOARD_SECTIONS = ['Commits', 'Pull Requests', 'Issues', 'Cycle Time']

function App() {
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
              <input type="password" placeholder="ghp_xxxxxxxxxxxxxxxxxxxx" />
            </label>
            <div className="action-row">
              <button type="button">Validate Token</button>
              <button type="button">Clear Token</button>
            </div>
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
