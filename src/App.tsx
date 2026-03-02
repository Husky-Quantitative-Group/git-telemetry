import { useEffect, useMemo, useRef, useState } from 'react'
import { GITHUB_GRAPHQL_ENDPOINT, GITHUB_REST_ENDPOINT } from './config/env'
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
const RUN_STEPS = [
  { key: 'tokenCheck', label: 'Token Check' },
  { key: 'repoPrep', label: 'Repo Prep' },
  { key: 'prs', label: 'PRs' },
  { key: 'issues', label: 'Issues' },
  { key: 'commits', label: 'Commits' },
  { key: 'aggregate', label: 'Aggregate' },
] as const
const REPO_DATA_COLUMNS = [
  { key: 'defaultBranch', label: 'Default Branch' },
  { key: 'prs', label: 'PRs' },
  { key: 'issues', label: 'Issues' },
  { key: 'commits', label: 'Commits' },
] as const
const MOCK_REPO_STEP_DELAY_MS = 220

type TokenValidationState = 'idle' | 'validating' | 'valid' | 'invalid' | 'error'
type RepositoryDiscoveryState = 'idle' | 'loading' | 'success' | 'error'
type RunPhase = 'idle' | 'running' | 'done' | 'partial' | 'error' | 'cancelled'
type ProgressStatus = 'queued' | 'fetching' | 'done' | 'error'
type RunStepKey = (typeof RUN_STEPS)[number]['key']
type RepoDataKey = (typeof REPO_DATA_COLUMNS)[number]['key']

type GraphQLError = {
  message?: string
}

type TokenValidationStatus = {
  state: TokenValidationState
  message: string
  viewerLogin?: string
}

type RepositoryDiscoveryStatus = {
  state: RepositoryDiscoveryState
  message: string
}

type RepositorySummary = {
  id: string
  nameWithOwner: string
  isPrivate: boolean
  url: string
}

type StepStatusMap = Record<RunStepKey, ProgressStatus>
type RepoDataStatusMap = Record<RepoDataKey, ProgressStatus>

type RepoMatrixRow = {
  repoId: string
  repoName: string
  statuses: RepoDataStatusMap
}

type RunErrorItem = {
  step: RunStepKey
  message: string
  repoId?: string
  repoName?: string
  dataKey?: RepoDataKey
}

type ViewerValidationData = {
  viewer?: {
    login?: string
  }
}

type GitHubGraphQLResponse<TData> = {
  data?: TData
  errors?: GraphQLError[]
}
type RestRepositoryResponse = Array<{
  id?: number
  full_name?: string
  private?: boolean
  html_url?: string
}>

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function createStepStatusMap(initialStatus: ProgressStatus): StepStatusMap {
  return RUN_STEPS.reduce(
    (accumulator, step) => {
      accumulator[step.key] = initialStatus
      return accumulator
    },
    {} as StepStatusMap,
  )
}

function createRepoDataStatusMap(initialStatus: ProgressStatus): RepoDataStatusMap {
  return REPO_DATA_COLUMNS.reduce(
    (accumulator, column) => {
      accumulator[column.key] = initialStatus
      return accumulator
    },
    {} as RepoDataStatusMap,
  )
}

function getRepositoryOwner(nameWithOwner: string): string {
  const separatorIndex = nameWithOwner.indexOf('/')
  if (separatorIndex < 0) {
    return nameWithOwner
  }

  return nameWithOwner.slice(0, separatorIndex)
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

function extractGraphQLErrorMessage<TData>(payload: GitHubGraphQLResponse<TData> | null): string {
  if (!payload?.errors || payload.errors.length === 0) {
    return ''
  }

  return payload.errors[0]?.message ?? ''
}

async function executeGitHubGraphQL<TData>(
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ response: Response; payload: GitHubGraphQLResponse<TData> | null }> {
  const response = await fetch(GITHUB_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  })

  const payload = (await response.json().catch(() => null)) as GitHubGraphQLResponse<TData> | null

  return {
    response,
    payload,
  }
}

function App() {
  const [token, setToken] = useState<string>(() => readTokenFromStorage())
  const [persistToken, setPersistToken] = useState<boolean>(() => readTokenFromStorage().length > 0)
  const [isTokenHelpOpen, setIsTokenHelpOpen] = useState(false)
  const [repoSearchTerm, setRepoSearchTerm] = useState('')
  const [ownerFilter, setOwnerFilter] = useState('all')
  const [discoveredRepos, setDiscoveredRepos] = useState<RepositorySummary[]>([])
  const [selectedRepoIds, setSelectedRepoIds] = useState<string[]>([])
  const [tokenStatus, setTokenStatus] = useState<TokenValidationStatus>({
    state: 'idle',
    message: 'Token not validated yet.',
  })
  const [repoDiscoveryStatus, setRepoDiscoveryStatus] = useState<RepositoryDiscoveryStatus>({
    state: 'idle',
    message: 'No repositories loaded yet.',
  })
  const [runPhase, setRunPhase] = useState<RunPhase>('idle')
  const [currentRunId, setCurrentRunId] = useState<number | null>(null)
  const [activeStep, setActiveStep] = useState<RunStepKey | null>(null)
  const [stepStatuses, setStepStatuses] = useState<StepStatusMap>(() => createStepStatusMap('queued'))
  const [repoMatrixRows, setRepoMatrixRows] = useState<RepoMatrixRow[]>([])
  const [runErrors, setRunErrors] = useState<RunErrorItem[]>([])
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null)
  const [runFinishedAt, setRunFinishedAt] = useState<number | null>(null)
  const runSequenceRef = useRef(0)
  const activeRunRef = useRef<number | null>(null)

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

  useEffect(() => {
    if (!isTokenHelpOpen || typeof window === 'undefined') {
      return
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsTokenHelpOpen(false)
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => {
      window.removeEventListener('keydown', handleEscape)
    }
  }, [isTokenHelpOpen])

  async function validateTokenWithGitHub(trimmedToken: string): Promise<TokenValidationStatus> {
    try {
      const { response, payload } = await executeGitHubGraphQL<ViewerValidationData>(trimmedToken, VIEWER_QUERY)
      const errorMessage = extractGraphQLErrorMessage(payload)

      if (!response.ok) {
        if (response.status === 401 || errorMessage.toLowerCase().includes('bad credentials')) {
          return {
            state: 'invalid',
            message: 'Token is invalid or missing required permissions.',
          }
        }

        return {
          state: 'error',
          message: `Validation failed with HTTP ${response.status}.`,
        }
      }

      if (errorMessage.length > 0) {
        if (errorMessage.toLowerCase().includes('bad credentials')) {
          return {
            state: 'invalid',
            message: 'Token is invalid or missing required permissions.',
          }
        }

        return {
          state: 'error',
          message: errorMessage,
        }
      }

      const viewerLogin = payload?.data?.viewer?.login
      if (!viewerLogin) {
        return {
          state: 'error',
          message: 'Validation response did not include viewer login.',
        }
      }

      return {
        state: 'valid',
        message: `Token is valid for @${viewerLogin}.`,
        viewerLogin,
      }
    } catch {
      return {
        state: 'error',
        message: 'Network error while validating token.',
      }
    }
  }

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

    const validationStatus = await validateTokenWithGitHub(trimmedToken)
    setTokenStatus(validationStatus)
  }

  async function handleDiscoverRepositories() {
    const trimmedToken = token.trim()
    if (trimmedToken.length === 0) {
      setRepoDiscoveryStatus({
        state: 'error',
        message: 'Enter and validate a token before repo discovery.',
      })
      return
    }

    setRepoDiscoveryStatus({
      state: 'loading',
      message: 'Discovering repositories...',
    })

    const repositoriesById = new Map<string, RepositorySummary>()
    let hasNextPage = true
    let pagesFetched = 0

    try {
      let page = 1
      while (hasNextPage) {
        const url = new URL('/user/repos', GITHUB_REST_ENDPOINT)
        url.searchParams.set('affiliation', 'owner,organization_member,collaborator')
        url.searchParams.set('per_page', '100')
        url.searchParams.set('page', String(page))
        url.searchParams.set('sort', 'updated')
        url.searchParams.set('direction', 'desc')

        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${trimmedToken}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
        })

        const payload = (await response.json().catch(() => null)) as
          | RestRepositoryResponse
          | { message?: string }
          | null

        if (!response.ok) {
          const responseErrorMessage =
            payload && !Array.isArray(payload) && payload.message
              ? payload.message
              : `Repo discovery failed with HTTP ${response.status}.`

          setRepoDiscoveryStatus({
            state: 'error',
            message: responseErrorMessage,
          })
          return
        }

        if (!Array.isArray(payload)) {
          setRepoDiscoveryStatus({
            state: 'error',
            message: 'GitHub response did not include repository list data.',
          })
          return
        }

        for (const repo of payload) {
          if (!repo.id || !repo.full_name || !repo.html_url) {
            continue
          }

          const repoId = String(repo.id)
          repositoriesById.set(repoId, {
            id: repoId,
            nameWithOwner: repo.full_name,
            isPrivate: repo.private ?? false,
            url: repo.html_url,
          })
        }

        pagesFetched += 1
        setRepoDiscoveryStatus({
          state: 'loading',
          message: `Discovering repositories via HTTP... fetched ${pagesFetched} page${pagesFetched === 1 ? '' : 's'}.`,
        })

        hasNextPage = payload.length === 100
        page += 1
      }

      const repositoryList = Array.from(repositoriesById.values()).sort((a, b) =>
        a.nameWithOwner.localeCompare(b.nameWithOwner),
      )
      const discoveredRepoIdSet = new Set(repositoryList.map((repo) => repo.id))

      setDiscoveredRepos(repositoryList)
      setOwnerFilter((previous) => {
        if (previous === 'all') {
          return previous
        }

        const ownerExists = repositoryList.some((repo) => getRepositoryOwner(repo.nameWithOwner) === previous)
        return ownerExists ? previous : 'all'
      })
      setSelectedRepoIds((previous) => previous.filter((id) => discoveredRepoIdSet.has(id)))
      setRepoDiscoveryStatus({
        state: 'success',
        message: `Loaded ${repositoryList.length} repositories.`,
      })
    } catch {
      setRepoDiscoveryStatus({
        state: 'error',
        message: 'Network error while discovering repositories.',
      })
    }
  }

  function handleClearToken() {
    activeRunRef.current = null
    setToken('')
    setPersistToken(false)
    setRepoSearchTerm('')
    setOwnerFilter('all')
    setDiscoveredRepos([])
    setSelectedRepoIds([])
    setRunPhase('idle')
    setCurrentRunId(null)
    setActiveStep(null)
    setStepStatuses(createStepStatusMap('queued'))
    setRepoMatrixRows([])
    setRunErrors([])
    setRunStartedAt(null)
    setRunFinishedAt(null)
    setRepoDiscoveryStatus({
      state: 'idle',
      message: 'No repositories loaded yet.',
    })
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
  const isDiscoveringRepos = repoDiscoveryStatus.state === 'loading'
  const tokenStatusClassName = `token-status token-status--${tokenStatus.state}`
  const repoStatusClassName = `repo-status repo-status--${repoDiscoveryStatus.state}`
  const selectedRepoIdSet = useMemo(() => new Set(selectedRepoIds), [selectedRepoIds])
  const selectedRepos = useMemo(
    () => discoveredRepos.filter((repo) => selectedRepoIdSet.has(repo.id)),
    [discoveredRepos, selectedRepoIdSet],
  )
  const availableOwners = useMemo(() => {
    const uniqueOwners = new Set<string>()
    for (const repo of discoveredRepos) {
      uniqueOwners.add(getRepositoryOwner(repo.nameWithOwner))
    }

    return Array.from(uniqueOwners).sort((a, b) => a.localeCompare(b))
  }, [discoveredRepos])
  const filteredRepos = useMemo(() => {
    const searchValue = repoSearchTerm.trim().toLowerCase()
    const ownerFilteredRepos =
      ownerFilter === 'all'
        ? discoveredRepos
        : discoveredRepos.filter((repo) => getRepositoryOwner(repo.nameWithOwner) === ownerFilter)

    if (searchValue.length === 0) {
      return ownerFilteredRepos
    }

    return ownerFilteredRepos.filter((repo) => repo.nameWithOwner.toLowerCase().includes(searchValue))
  }, [discoveredRepos, ownerFilter, repoSearchTerm])
  const areAllVisibleReposSelected =
    filteredRepos.length > 0 && filteredRepos.every((repo) => selectedRepoIdSet.has(repo.id))
  const isRunInProgress = runPhase === 'running'

  const completedStepCount = useMemo(
    () => RUN_STEPS.filter((step) => stepStatuses[step.key] === 'done' || stepStatuses[step.key] === 'error').length,
    [stepStatuses],
  )
  const progressPercent = Math.round((completedStepCount / RUN_STEPS.length) * 100)
  const runDurationMs = runStartedAt && runFinishedAt ? runFinishedAt - runStartedAt : null
  const runPhaseLabel =
    runPhase === 'idle'
      ? 'Idle'
      : runPhase === 'running'
        ? 'Running'
        : runPhase === 'done'
          ? 'Done'
          : runPhase === 'partial'
            ? 'Partial'
            : runPhase === 'cancelled'
              ? 'Cancelled'
              : 'Error'
  const runPhaseClassName = `run-phase-badge run-phase-badge--${runPhase}`
  const rerunButtonLabel = runPhase === 'idle' ? 'Start Run' : 'Retry Run'

  function handleToggleRepositorySelection(repoId: string) {
    setSelectedRepoIds((previous) => {
      if (previous.includes(repoId)) {
        return previous.filter((id) => id !== repoId)
      }

      return [...previous, repoId]
    })
  }

  function handleSelectAllVisibleRepos() {
    if (filteredRepos.length === 0) {
      return
    }

    setSelectedRepoIds((previous) => {
      const nextSelected = new Set(previous)
      for (const repo of filteredRepos) {
        nextSelected.add(repo.id)
      }

      return Array.from(nextSelected)
    })
  }

  function handleClearSelectedRepos() {
    setSelectedRepoIds([])
  }

  function setStepStatus(stepKey: RunStepKey, status: ProgressStatus) {
    setStepStatuses((previous) => ({
      ...previous,
      [stepKey]: status,
    }))
  }

  function setRepoDataStatus(repoId: string, dataKey: RepoDataKey, status: ProgressStatus) {
    setRepoMatrixRows((previous) =>
      previous.map((row) =>
        row.repoId === repoId
          ? {
              ...row,
              statuses: {
                ...row.statuses,
                [dataKey]: status,
              },
            }
          : row,
      ),
    )
  }

  function isRunActive(runId: number): boolean {
    return activeRunRef.current === runId
  }

  async function runRepoStep(
    runId: number,
    stepKey: RunStepKey,
    dataKey: RepoDataKey,
    repositories: RepositorySummary[],
  ): Promise<boolean> {
    setActiveStep(stepKey)
    setStepStatus(stepKey, 'fetching')

    for (const repository of repositories) {
      if (!isRunActive(runId)) {
        return false
      }

      setRepoDataStatus(repository.id, dataKey, 'fetching')
      await delay(MOCK_REPO_STEP_DELAY_MS)

      if (!isRunActive(runId)) {
        return false
      }

      setRepoDataStatus(repository.id, dataKey, 'done')
    }

    setStepStatus(stepKey, 'done')
    return true
  }

  async function handleRunAnalysis() {
    const trimmedToken = token.trim()
    if (trimmedToken.length === 0) {
      setTokenStatus({
        state: 'invalid',
        message: 'Enter a GitHub token before running analysis.',
      })
      return
    }

    if (selectedRepos.length === 0) {
      setRepoDiscoveryStatus({
        state: 'error',
        message: 'Select at least one repository before running analysis.',
      })
      return
    }

    const runId = runSequenceRef.current + 1
    runSequenceRef.current = runId
    activeRunRef.current = runId
    const runStarted = Date.now()

    setCurrentRunId(runId)
    setRunPhase('running')
    setActiveStep(null)
    setRunErrors([])
    setRunStartedAt(runStarted)
    setRunFinishedAt(null)
    setStepStatuses(createStepStatusMap('queued'))
    setRepoMatrixRows(
      selectedRepos.map((repo) => ({
        repoId: repo.id,
        repoName: repo.nameWithOwner,
        statuses: createRepoDataStatusMap('queued'),
      })),
    )

    setStepStatus('tokenCheck', 'fetching')
    setActiveStep('tokenCheck')
    setTokenStatus({
      state: 'validating',
      message: 'Validating token against GitHub GraphQL...',
    })
    const validationStatus = await validateTokenWithGitHub(trimmedToken)

    if (!isRunActive(runId)) {
      return
    }

    setTokenStatus(validationStatus)
    if (validationStatus.state !== 'valid') {
      setStepStatus('tokenCheck', 'error')
      setRunErrors([
        {
          step: 'tokenCheck',
          message: validationStatus.message,
        },
      ])
      setRunPhase('error')
      setRunFinishedAt(Date.now())
      setActiveStep(null)
      activeRunRef.current = null
      return
    }
    setStepStatus('tokenCheck', 'done')

    setActiveStep('repoPrep')
    setStepStatus('repoPrep', 'fetching')
    for (const repository of selectedRepos) {
      if (!isRunActive(runId)) {
        return
      }

      setRepoDataStatus(repository.id, 'defaultBranch', 'fetching')
      await delay(MOCK_REPO_STEP_DELAY_MS)
      if (!isRunActive(runId)) {
        return
      }

      setRepoDataStatus(repository.id, 'defaultBranch', 'done')
    }
    setStepStatus('repoPrep', 'done')

    const prStepCompleted = await runRepoStep(runId, 'prs', 'prs', selectedRepos)
    if (!prStepCompleted) {
      return
    }

    const issuesStepCompleted = await runRepoStep(runId, 'issues', 'issues', selectedRepos)
    if (!issuesStepCompleted) {
      return
    }

    const commitsStepCompleted = await runRepoStep(runId, 'commits', 'commits', selectedRepos)
    if (!commitsStepCompleted) {
      return
    }

    setActiveStep('aggregate')
    setStepStatus('aggregate', 'fetching')
    await delay(MOCK_REPO_STEP_DELAY_MS)
    if (!isRunActive(runId)) {
      return
    }
    setStepStatus('aggregate', 'done')

    setRunPhase('done')
    setRunFinishedAt(Date.now())
    setActiveStep(null)
    activeRunRef.current = null
  }

  function handleCancelRun() {
    if (!isRunInProgress) {
      return
    }

    activeRunRef.current = null
    setRunPhase('cancelled')
    setActiveStep(null)
    setRunFinishedAt(Date.now())
  }

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
          <div className="panel-heading">
            <h2>Authentication</h2>
            <button type="button" className="text-button" onClick={() => setIsTokenHelpOpen(true)}>
              How to create token
            </button>
          </div>
          <div className="control-grid control-grid--single">
            <label className="control-field control-field--full">
              <span>GitHub Token</span>
              <input
                type="password"
                placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                value={token}
                onChange={(event) => {
                  activeRunRef.current = null
                  setToken(event.target.value)
                  setRepoSearchTerm('')
                  setOwnerFilter('all')
                  setDiscoveredRepos([])
                  setSelectedRepoIds([])
                  setRunPhase('idle')
                  setCurrentRunId(null)
                  setActiveStep(null)
                  setStepStatuses(createStepStatusMap('queued'))
                  setRepoMatrixRows([])
                  setRunErrors([])
                  setRunStartedAt(null)
                  setRunFinishedAt(null)
                  setRepoDiscoveryStatus({
                    state: 'idle',
                    message: 'No repositories loaded yet.',
                  })
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
            <label className="control-field">
              <span>Owner Filter</span>
              <select
                value={ownerFilter}
                onChange={(event) => setOwnerFilter(event.target.value)}
                disabled={availableOwners.length === 0}
              >
                <option value="all">All owners</option>
                {availableOwners.map((owner) => (
                  <option key={owner} value={owner}>
                    {owner}
                  </option>
                ))}
              </select>
            </label>
            <label className="control-field control-field--full">
              <span>Repository Search</span>
              <input
                type="text"
                placeholder="Filter discovered repositories by owner/repo"
                value={repoSearchTerm}
                onChange={(event) => setRepoSearchTerm(event.target.value)}
                disabled={discoveredRepos.length === 0}
              />
            </label>
            <div className="action-row">
              <button type="button" onClick={handleDiscoverRepositories} disabled={isDiscoveringRepos || isRunInProgress}>
                {isDiscoveringRepos ? 'Discovering...' : 'Discover Repos'}
              </button>
              <button
                type="button"
                onClick={handleSelectAllVisibleRepos}
                disabled={filteredRepos.length === 0 || areAllVisibleReposSelected || isRunInProgress}
              >
                Select All Visible
              </button>
              <button
                type="button"
                onClick={handleClearSelectedRepos}
                disabled={selectedRepoIds.length === 0 || isRunInProgress}
              >
                Clear Selection
              </button>
              <button
                type="button"
                className="button-primary"
                onClick={handleRunAnalysis}
                disabled={isRunInProgress || isDiscoveringRepos || selectedRepos.length === 0}
              >
                {isRunInProgress ? 'Running...' : 'Run Analysis'}
              </button>
            </div>
            <p className={repoStatusClassName}>{repoDiscoveryStatus.message}</p>
            <div className="repo-selection-panel">
              <p className="repo-selection-summary">
                Selected {selectedRepoIds.length} of {discoveredRepos.length} repositories
              </p>
              {filteredRepos.length === 0 ? (
                <p className="repo-selection-empty">
                  {discoveredRepos.length === 0
                    ? 'Discover repositories to start selecting.'
                    : 'No repositories match your search.'}
                </p>
              ) : (
                <ul className="repo-list">
                  {filteredRepos.map((repo) => (
                    <li key={repo.id}>
                      <label className="repo-checkbox-label">
                        <input
                          type="checkbox"
                          checked={selectedRepoIdSet.has(repo.id)}
                          onChange={() => handleToggleRepositorySelection(repo.id)}
                        />
                        <span>{repo.nameWithOwner}</span>
                        <span className="repo-visibility">{repo.isPrivate ? 'Private' : 'Public'}</span>
                      </label>
                      <a href={repo.url} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </header>

      <section className="panel status-panel">
        <div className="status-header">
          <div>
            <h2>Fetch Status</h2>
            <p>Run #{currentRunId ?? '-'} · {runPhaseLabel}</p>
          </div>
          <div className="status-actions">
            <span className={runPhaseClassName}>{runPhaseLabel}</span>
            {isRunInProgress ? (
              <button type="button" onClick={handleCancelRun}>
                Cancel Run
              </button>
            ) : (
              <button
                type="button"
                onClick={handleRunAnalysis}
                disabled={selectedRepos.length === 0 || isDiscoveringRepos}
              >
                {rerunButtonLabel}
              </button>
            )}
          </div>
        </div>

        <div className="run-meta">
          <p>Progress: {progressPercent}% ({completedStepCount}/{RUN_STEPS.length} steps)</p>
          <p>Active Step: {activeStep ? RUN_STEPS.find((step) => step.key === activeStep)?.label : 'None'}</p>
          <p>Selected Repos: {selectedRepos.length}</p>
          <p>Duration: {runDurationMs === null ? '-' : `${Math.max(1, Math.round(runDurationMs / 1000))}s`}</p>
        </div>

        <div className="step-progress-panel">
          {RUN_STEPS.map((step) => (
            <div className="step-progress-row" key={step.key}>
              <span>{step.label}</span>
              <span className={`status-chip status-chip--${stepStatuses[step.key]}`}>{stepStatuses[step.key]}</span>
            </div>
          ))}
        </div>

        <div className="matrix-panel">
          <h3>Per-Repo Matrix</h3>
          {repoMatrixRows.length === 0 ? (
            <p className="matrix-empty">Run analysis to populate per-repository fetch statuses.</p>
          ) : (
            <div className="matrix-scroll">
              <table className="matrix-table">
                <thead>
                  <tr>
                    <th>Repository</th>
                    {REPO_DATA_COLUMNS.map((column) => (
                      <th key={column.key}>{column.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {repoMatrixRows.map((row) => (
                    <tr key={row.repoId}>
                      <td>{row.repoName}</td>
                      {REPO_DATA_COLUMNS.map((column) => (
                        <td key={`${row.repoId}-${column.key}`}>
                          <span className={`status-chip status-chip--${row.statuses[column.key]}`}>
                            {row.statuses[column.key]}
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {runErrors.length > 0 && (
          <div className="run-errors-panel">
            <h3>Run Errors</h3>
            <ul>
              {runErrors.map((errorItem, index) => (
                <li key={`${errorItem.step}-${errorItem.repoId ?? 'global'}-${index}`}>
                  <strong>{RUN_STEPS.find((step) => step.key === errorItem.step)?.label}:</strong> {errorItem.message}
                </li>
              ))}
            </ul>
          </div>
        )}

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

      {isTokenHelpOpen && (
        <div className="modal-backdrop" onClick={() => setIsTokenHelpOpen(false)}>
          <section
            className="token-help-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="token-help-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="token-help-header">
              <h3 id="token-help-title">Create a GitHub token</h3>
              <button type="button" className="text-button" onClick={() => setIsTokenHelpOpen(false)}>
                Close
              </button>
            </div>
            <ol className="token-help-list">
              <li>Open Personal access tokens in GitHub settings.</li>
              <li>Create a Fine-grained token.</li>
              <li>Select the owner that contains the repositories you want to analyze.</li>
              <li>Choose repository access for the repos you want to include.</li>
              <li>Set read permissions: Metadata, Contents, Pull requests, and Issues.</li>
              <li>Generate token, copy it once, and paste it into this app.</li>
            </ol>
            <p className="token-help-note">
              Fine-grained tokens are owner-scoped. If you analyze repos across multiple owners, you may need
              multiple tokens.
            </p>
            <a
              className="token-help-link"
              href="https://github.com/settings/personal-access-tokens/new"
              target="_blank"
              rel="noreferrer"
            >
              Open GitHub token settings
            </a>
          </section>
        </div>
      )}
    </div>
  )
}

export default App
