import { useEffect, useMemo, useRef, useState } from 'react'
import Select, { components, type MultiValue, type OptionProps } from 'react-select'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { GITHUB_GRAPHQL_ENDPOINT, GITHUB_REST_ENDPOINT } from './config/env'
import './App.css'

const TOKEN_STORAGE_KEY = 'gitTelemetry.githubToken'
const THEME_STORAGE_KEY = 'gitTelemetry.themeMode'
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
const CHART_COLORS = [
  '#4e79a7',
  '#f28e2b',
  '#e15759',
  '#76b7b2',
  '#59a14f',
  '#edc948',
  '#b07aa1',
  '#ff9da7',
  '#9c755f',
  '#bab0ab',
]
const CHART_GRID_COLOR = 'var(--chart-grid)'
const CHART_AXIS_COLOR = 'var(--chart-axis)'
const CHART_TOOLTIP_BORDER = 'var(--chart-tooltip-border)'
const CHART_TOOLTIP_LABEL = 'var(--chart-tooltip-label)'
const CHART_AGGREGATE_COLOR = 'var(--chart-aggregate)'
const CHART_TURNAROUND_BUCKET_COLOR = 'var(--chart-turnaround-bucket)'
const CHART_TURNAROUND_ROLLING_COLOR = 'var(--chart-turnaround-rolling)'
const NO_REPO_SELECTION = '__none__'
const ALL_REPOS_OPTION = '__all__'
const UNKNOWN_USER_ID = '__unknown_user__'
const REPOSITORY_DEFAULT_BRANCH_QUERY = `
  query RepositoryDefaultBranch($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef {
        name
      }
    }
  }
`
const SEARCH_PULL_REQUESTS_QUERY = `
  query SearchPullRequests($searchQuery: String!, $cursor: String) {
    search(type: ISSUE, query: $searchQuery, first: 100, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ... on PullRequest {
          id
          number
          title
          url
          createdAt
          mergedAt
          isDraft
          author {
            login
          }
        }
      }
    }
  }
`
const SEARCH_ISSUES_QUERY = `
  query SearchIssues($searchQuery: String!, $cursor: String) {
    search(type: ISSUE, query: $searchQuery, first: 100, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ... on Issue {
          id
          number
          title
          url
          createdAt
          closedAt
          author {
            login
          }
        }
      }
    }
  }
`
const REPOSITORY_COMMITS_QUERY = `
  query RepositoryCommits(
    $owner: String!
    $name: String!
    $qualifiedName: String!
    $cursor: String
    $since: GitTimestamp
    $until: GitTimestamp
  ) {
    repository(owner: $owner, name: $name) {
      ref(qualifiedName: $qualifiedName) {
        target {
          ... on Commit {
            history(first: 100, after: $cursor, since: $since, until: $until) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                oid
                committedDate
                authoredDate
                url
                author {
                  user {
                    login
                  }
                  name
                }
              }
            }
          }
        }
      }
    }
  }
`

type TokenValidationState = 'idle' | 'validating' | 'valid' | 'invalid' | 'error'
type RepositoryDiscoveryState = 'idle' | 'loading' | 'success' | 'error'
type RunPhase = 'idle' | 'running' | 'done' | 'partial' | 'error' | 'cancelled'
type ThemeMode = 'light' | 'dark'
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

type LoadedRepoOption = {
  repoId: string
  repoName: string
}

type LoadedUserOption = {
  userId: string
  userLabel: string
}

type SelectFilterOption = {
  id: string
  label: string
}

type MultiSelectOption = {
  value: string
  label: string
  isAll?: boolean
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

type RunDateRange = {
  startIso: string
  endIso: string
  startDay: string
  endDay: string
  label: string
}

type RateLimitSnapshot = {
  limit: number
  remaining: number
  used: number
  resetAt: string
  updatedAt: string
}

type PullRequestRecord = {
  id: string
  number: number
  title: string
  url: string
  createdAt: string
  mergedAt: string | null
  isDraft: boolean
  authorLogin?: string
}

type IssueRecord = {
  id: string
  number: number
  title: string
  url: string
  createdAt: string
  closedAt?: string | null
  authorLogin?: string
}

type CommitRecord = {
  oid: string
  authoredDate: string
  committedDate: string
  url: string
  authorLogin?: string
  authorName?: string
}

type RawPullRequestRecord = {
  id?: string
  number?: number
  title?: string
  url?: string
  createdAt?: string
  mergedAt?: string
  isDraft?: boolean
  authorLogin?: string
}

type RawIssueRecord = {
  id?: string
  number?: number
  title?: string
  url?: string
  createdAt?: string
  closedAt?: string | null
  authorLogin?: string
}

type RawCommitRecord = {
  oid?: string
  authoredDate?: string
  committedDate?: string
  url?: string
  authorLogin?: string
  authorName?: string
}

type RepoAnalysisData = {
  repoId: string
  repoName: string
  defaultBranch?: string
  pullRequests: PullRequestRecord[]
  pullRequestsOpened: PullRequestRecord[]
  issuesOpened: IssueRecord[]
  issuesClosed: IssueRecord[]
  commits: CommitRecord[]
}

type RepoRawAnalysisData = {
  repoId: string
  repoName: string
  defaultBranch?: string
  pullRequests: RawPullRequestRecord[]
  pullRequestsOpened: RawPullRequestRecord[]
  issuesOpened: RawIssueRecord[]
  issuesClosed: RawIssueRecord[]
  commits: RawCommitRecord[]
}

type AggregationGranularity = 'daily' | 'weekly' | 'monthly'
type CommitsChartScopeMode = 'all' | 'multi' | 'single'
type ChartBreakdownMode = 'aggregate' | 'byRepo' | 'byUser'
type ChartStyle = 'line' | 'bar' | 'cumulative'

type AggregatedBucketPoint = {
  bucketStart: string
  bucketLabel: string
  total: number
  byRepo: Record<string, number>
  byUser: Record<string, number>
}

type AggregatedRepoTotals = {
  repoId: string
  repoName: string
  commits: number
  prsOpened: number
  prsMerged: number
  issuesOpened: number
  issuesClosed: number
  mergeTimeCount: number
  mergeTimeAverageDays: number | null
  mergeTimeMedianDays: number | null
}

type AggregatedActivity = {
  range: RunDateRange
  granularity: AggregationGranularity
  repoIds: string[]
  totals: {
    commits: number
    prsOpened: number
    prsMerged: number
    issuesOpened: number
    issuesClosed: number
  }
  mergeTime: {
    count: number
    averageDays: number | null
    medianDays: number | null
  }
  series: {
    commits: AggregatedBucketPoint[]
    prsOpened: AggregatedBucketPoint[]
    prsMerged: AggregatedBucketPoint[]
    issuesOpened: AggregatedBucketPoint[]
    issuesClosed: AggregatedBucketPoint[]
  }
  perRepoTotals: AggregatedRepoTotals[]
}

type MergeTimeTrendPoint = {
  bucketStart: string
  bucketLabel: string
  count: number
  averageDays: number | null
  medianDays: number | null
}

type MergeTimeTrendChartPoint = MergeTimeTrendPoint & {
  rollingAverageDays: number | null
}

type ViewerValidationData = {
  viewer?: {
    login?: string
  }
}

type RepositoryDefaultBranchData = {
  repository?: {
    defaultBranchRef?: {
      name?: string
    } | null
  } | null
}

type SearchConnectionPageInfo = {
  hasNextPage?: boolean
  endCursor?: string | null
}

type SearchPullRequestsData = {
  search?: {
    pageInfo?: SearchConnectionPageInfo
    nodes?: Array<
      | {
          id?: string
          number?: number
          title?: string
          url?: string
          createdAt?: string
          mergedAt?: string
          isDraft?: boolean
          author?: { login?: string } | null
        }
      | null
    >
  } | null
}

type SearchIssuesData = {
  search?: {
    pageInfo?: SearchConnectionPageInfo
    nodes?: Array<
      | {
          id?: string
          number?: number
          title?: string
          url?: string
          createdAt?: string
          closedAt?: string | null
          author?: { login?: string } | null
        }
      | null
    >
  } | null
}

type RepositoryCommitsData = {
  repository?: {
    ref?: {
      target?: {
        history?: {
          pageInfo?: SearchConnectionPageInfo
          nodes?: Array<
            | {
                oid?: string
                authoredDate?: string
                committedDate?: string
                url?: string
                author?: {
                  user?: { login?: string } | null
                  name?: string | null
                } | null
              }
            | null
          >
        } | null
      } | null
    } | null
  } | null
}

type SearchPullRequestConnection = NonNullable<SearchPullRequestsData['search']>
type SearchIssuesConnection = NonNullable<SearchIssuesData['search']>
type CommitHistoryConnection = NonNullable<
  NonNullable<NonNullable<NonNullable<RepositoryCommitsData['repository']>['ref']>['target']>['history']
>

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

function formatDateInput(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function getDateDaysAgo(days: number): Date {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - days)
  return date
}

function buildRunDateRangeFromDays(startDay: string, endDay: string, label: string): RunDateRange {
  const startDate = new Date(`${startDay}T00:00:00.000Z`)
  const endDate = new Date(`${endDay}T23:59:59.999Z`)

  return {
    startIso: startDate.toISOString(),
    endIso: endDate.toISOString(),
    startDay,
    endDay,
    label,
  }
}

function resolveChartDateRangeWithinCore(
  coreRange: RunDateRange | null,
  startDay: string,
  endDay: string,
): { ok: true; range: RunDateRange } | { ok: false; message: string } {
  if (!coreRange) {
    return {
      ok: false,
      message: 'Run analysis to set the core date range.',
    }
  }

  if (startDay.length === 0 || endDay.length === 0) {
    return {
      ok: false,
      message: 'Choose both start and end dates.',
    }
  }

  const startDate = new Date(`${startDay}T00:00:00.000Z`)
  const endDate = new Date(`${endDay}T23:59:59.999Z`)
  if (Number.isNaN(startDate.valueOf()) || Number.isNaN(endDate.valueOf())) {
    return {
      ok: false,
      message: 'Chart date range is invalid.',
    }
  }

  if (startDay > endDay) {
    return {
      ok: false,
      message: 'Chart start date must be before end date.',
    }
  }

  if (startDay < coreRange.startDay || endDay > coreRange.endDay) {
    return {
      ok: false,
      message: `Chart range must stay within core range (${coreRange.startDay} to ${coreRange.endDay}).`,
    }
  }

  return {
    ok: true,
    range: buildRunDateRangeFromDays(startDay, endDay, `${startDay} to ${endDay}`),
  }
}

function splitRepositoryName(nameWithOwner: string): { owner: string; name: string } | null {
  const separatorIndex = nameWithOwner.indexOf('/')
  if (separatorIndex <= 0 || separatorIndex >= nameWithOwner.length - 1) {
    return null
  }

  return {
    owner: nameWithOwner.slice(0, separatorIndex),
    name: nameWithOwner.slice(separatorIndex + 1),
  }
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

function getRepositoryShortName(nameWithOwner: string): string {
  const separatorIndex = nameWithOwner.indexOf('/')
  if (separatorIndex < 0 || separatorIndex >= nameWithOwner.length - 1) {
    return nameWithOwner
  }

  return nameWithOwner.slice(separatorIndex + 1)
}

function normalizeUserId(candidate?: string): string | null {
  if (!candidate) {
    return null
  }

  const normalized = candidate.trim()
  return normalized.length > 0 ? normalized : null
}

function getPullRequestUserId(pullRequest: PullRequestRecord): string {
  return normalizeUserId(pullRequest.authorLogin) ?? UNKNOWN_USER_ID
}

function getIssueUserId(issue: IssueRecord): string {
  return normalizeUserId(issue.authorLogin) ?? UNKNOWN_USER_ID
}

function getCommitUserId(commit: CommitRecord): string {
  return normalizeUserId(commit.authorLogin) ?? normalizeUserId(commit.authorName) ?? UNKNOWN_USER_ID
}

function getUserDisplayLabel(userId: string): string {
  return userId === UNKNOWN_USER_ID ? 'Unknown' : userId
}

function parseRateLimitSnapshot(response: Response): RateLimitSnapshot | null {
  const limit = Number(response.headers.get('x-ratelimit-limit'))
  const remaining = Number(response.headers.get('x-ratelimit-remaining'))
  const used = Number(response.headers.get('x-ratelimit-used'))
  const resetSeconds = Number(response.headers.get('x-ratelimit-reset'))

  if (
    Number.isNaN(limit) ||
    Number.isNaN(remaining) ||
    Number.isNaN(used) ||
    Number.isNaN(resetSeconds)
  ) {
    return null
  }

  return {
    limit,
    remaining,
    used,
    resetAt: new Date(resetSeconds * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function getGraphQLRequestError<TData>(
  response: Response,
  payload: GitHubGraphQLResponse<TData> | null,
): string | null {
  const graphQlMessage = extractGraphQLErrorMessage(payload)
  if (!response.ok) {
    if (graphQlMessage.length > 0) {
      return graphQlMessage
    }

    return `GitHub request failed with HTTP ${response.status}.`
  }

  if (graphQlMessage.length > 0) {
    return graphQlMessage
  }

  if (!payload?.data) {
    return 'GitHub response did not include data.'
  }

  return null
}

function normalizeText(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeIsoTimestamp(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const parsedDate = new Date(value)
  if (Number.isNaN(parsedDate.valueOf())) {
    return undefined
  }

  return parsedDate.toISOString()
}

function normalizeDefaultBranch(value: string | undefined): string | undefined {
  return normalizeText(value)
}

function normalizePullRequestRecords(
  rawRecords: RawPullRequestRecord[],
  options?: { requireMergedAt?: boolean },
): PullRequestRecord[] {
  const normalized: PullRequestRecord[] = []
  const seenIds = new Set<string>()
  const requireMergedAt = options?.requireMergedAt ?? true

  for (const raw of rawRecords) {
    const id = normalizeText(raw.id)
    const title = normalizeText(raw.title)
    const url = normalizeText(raw.url)
    const createdAt = normalizeIsoTimestamp(raw.createdAt)
    const mergedAt = normalizeIsoTimestamp(raw.mergedAt) ?? null
    if (!id || seenIds.has(id) || raw.number === undefined || !title || !url || !createdAt) {
      continue
    }

    if (requireMergedAt && !mergedAt) {
      continue
    }

    normalized.push({
      id,
      number: raw.number,
      title,
      url,
      createdAt,
      mergedAt,
      isDraft: raw.isDraft ?? false,
      authorLogin: normalizeText(raw.authorLogin),
    })
    seenIds.add(id)
  }

  return normalized
}

function normalizeIssueRecords(rawRecords: RawIssueRecord[]): IssueRecord[] {
  const normalized: IssueRecord[] = []
  const seenIds = new Set<string>()

  for (const raw of rawRecords) {
    const id = normalizeText(raw.id)
    const title = normalizeText(raw.title)
    const url = normalizeText(raw.url)
    const createdAt = normalizeIsoTimestamp(raw.createdAt)
    if (!id || seenIds.has(id) || raw.number === undefined || !title || !url || !createdAt) {
      continue
    }

    normalized.push({
      id,
      number: raw.number,
      title,
      url,
      createdAt,
      closedAt: normalizeIsoTimestamp(raw.closedAt) ?? null,
      authorLogin: normalizeText(raw.authorLogin),
    })
    seenIds.add(id)
  }

  return normalized
}

function normalizeCommitRecords(rawRecords: RawCommitRecord[]): CommitRecord[] {
  const normalized: CommitRecord[] = []
  const seenOids = new Set<string>()

  for (const raw of rawRecords) {
    const oid = normalizeText(raw.oid)
    const url = normalizeText(raw.url)
    const authoredDate = normalizeIsoTimestamp(raw.authoredDate)
    const committedDate = normalizeIsoTimestamp(raw.committedDate)
    if (!oid || seenOids.has(oid) || !url || !authoredDate || !committedDate) {
      continue
    }

    normalized.push({
      oid,
      authoredDate,
      committedDate,
      url,
      authorLogin: normalizeText(raw.authorLogin),
      authorName: normalizeText(raw.authorName),
    })
    seenOids.add(oid)
  }

  return normalized
}

function normalizeRepositoryAnalysisData(raw: RepoRawAnalysisData): RepoAnalysisData {
  return {
    repoId: raw.repoId,
    repoName: raw.repoName,
    defaultBranch: normalizeDefaultBranch(raw.defaultBranch),
    pullRequests: normalizePullRequestRecords(raw.pullRequests, { requireMergedAt: true }),
    pullRequestsOpened: normalizePullRequestRecords(raw.pullRequestsOpened, { requireMergedAt: false }),
    issuesOpened: normalizeIssueRecords(raw.issuesOpened),
    issuesClosed: normalizeIssueRecords(raw.issuesClosed),
    commits: normalizeCommitRecords(raw.commits),
  }
}

function getBucketStartDate(timestampIso: string, granularity: AggregationGranularity): Date | null {
  const parsedDate = new Date(timestampIso)
  if (Number.isNaN(parsedDate.valueOf())) {
    return null
  }

  const bucketDate = new Date(Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), parsedDate.getUTCDate()))
  if (granularity === 'weekly') {
    const dayOffsetFromSunday = bucketDate.getUTCDay()
    bucketDate.setUTCDate(bucketDate.getUTCDate() - dayOffsetFromSunday)
  } else if (granularity === 'monthly') {
    bucketDate.setUTCDate(1)
  }

  return bucketDate
}

function incrementBucketDate(bucketDate: Date, granularity: AggregationGranularity): Date {
  const next = new Date(bucketDate.getTime())
  if (granularity === 'daily') {
    next.setUTCDate(next.getUTCDate() + 1)
  } else if (granularity === 'weekly') {
    next.setUTCDate(next.getUTCDate() + 7)
  } else {
    next.setUTCMonth(next.getUTCMonth() + 1)
    next.setUTCDate(1)
  }

  return next
}

function formatBucketLabel(bucketStartIso: string, granularity: AggregationGranularity): string {
  if (granularity === 'daily') {
    return bucketStartIso.slice(0, 10)
  }

  if (granularity === 'weekly') {
    return `Week of ${bucketStartIso.slice(0, 10)}`
  }

  return bucketStartIso.slice(0, 7)
}

function createBucketTimeline(range: RunDateRange, granularity: AggregationGranularity): string[] {
  const timeline: string[] = []
  const startBucketDate = getBucketStartDate(range.startIso, granularity)
  if (!startBucketDate) {
    return timeline
  }

  const rangeEndTime = new Date(range.endIso).valueOf()
  let cursor = startBucketDate
  while (cursor.valueOf() <= rangeEndTime) {
    timeline.push(cursor.toISOString())
    cursor = incrementBucketDate(cursor, granularity)
  }

  return timeline
}

function calculateAverage(values: number[]): number | null {
  if (values.length === 0) {
    return null
  }

  const sum = values.reduce((accumulator, value) => accumulator + value, 0)
  return sum / values.length
}

function calculateMedian(values: number[]): number | null {
  if (values.length === 0) {
    return null
  }

  const sorted = [...values].sort((left, right) => left - right)
  const middleIndex = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[middleIndex - 1] + sorted[middleIndex]) / 2
  }

  return sorted[middleIndex]
}

function getGranularityUnit(granularity: AggregationGranularity): 'day' | 'week' | 'month' {
  if (granularity === 'daily') {
    return 'day'
  }
  if (granularity === 'weekly') {
    return 'week'
  }
  return 'month'
}

function calculatePerTimeStats(series: AggregatedBucketPoint[]): { average: number | null; median: number | null } {
  const values = series.map((point) => point.total)
  return {
    average: calculateAverage(values),
    median: calculateMedian(values),
  }
}

function aggregateRepositoryActivity(
  analysisByRepo: Record<string, RepoAnalysisData>,
  repoIds: string[],
  range: RunDateRange,
  granularity: AggregationGranularity,
  selectedUserIds: string[],
): AggregatedActivity {
  const bucketTimeline = createBucketTimeline(range, granularity)
  const bucketPointMap = {
    commits: new Map<string, AggregatedBucketPoint>(),
    prsOpened: new Map<string, AggregatedBucketPoint>(),
    prsMerged: new Map<string, AggregatedBucketPoint>(),
    issuesOpened: new Map<string, AggregatedBucketPoint>(),
    issuesClosed: new Map<string, AggregatedBucketPoint>(),
  }

  for (const bucketStart of bucketTimeline) {
    const pointBase = {
      bucketStart,
      bucketLabel: formatBucketLabel(bucketStart, granularity),
      total: 0,
      byRepo: {} as Record<string, number>,
      byUser: {} as Record<string, number>,
    }
    bucketPointMap.commits.set(bucketStart, { ...pointBase, byRepo: {}, byUser: {} })
    bucketPointMap.prsOpened.set(bucketStart, { ...pointBase, byRepo: {}, byUser: {} })
    bucketPointMap.prsMerged.set(bucketStart, { ...pointBase, byRepo: {}, byUser: {} })
    bucketPointMap.issuesOpened.set(bucketStart, { ...pointBase, byRepo: {}, byUser: {} })
    bucketPointMap.issuesClosed.set(bucketStart, { ...pointBase, byRepo: {}, byUser: {} })
  }

  const rangeStartTime = new Date(range.startIso).valueOf()
  const rangeEndTime = new Date(range.endIso).valueOf()
  const selectedUserIdSet = new Set(selectedUserIds)
  const globalMergeDurations: number[] = []
  const perRepoTotals: AggregatedRepoTotals[] = []

  function addToBucket(
    bucketMap: Map<string, AggregatedBucketPoint>,
    bucketIso: string,
    repoId: string,
    userId: string,
    incrementBy: number,
  ) {
    const bucketPoint = bucketMap.get(bucketIso)
    if (!bucketPoint) {
      return
    }

    bucketPoint.total += incrementBy
    bucketPoint.byRepo[repoId] = (bucketPoint.byRepo[repoId] ?? 0) + incrementBy
    bucketPoint.byUser[userId] = (bucketPoint.byUser[userId] ?? 0) + incrementBy
  }

  for (const repoId of repoIds) {
    const repoData = analysisByRepo[repoId]
    if (!repoData) {
      continue
    }

    let repoCommits = 0
    let repoPrsOpened = 0
    let repoPrsMerged = 0
    let repoIssuesOpened = 0
    let repoIssuesClosed = 0
    const repoMergeDurations: number[] = []

    for (const commit of repoData.commits) {
      const commitUserId = getCommitUserId(commit)
      if (!selectedUserIdSet.has(commitUserId)) {
        continue
      }

      const commitTime = new Date(commit.authoredDate).valueOf()
      if (Number.isNaN(commitTime) || commitTime < rangeStartTime || commitTime > rangeEndTime) {
        continue
      }

      const bucketStartDate = getBucketStartDate(commit.authoredDate, granularity)
      if (!bucketStartDate) {
        continue
      }

      addToBucket(bucketPointMap.commits, bucketStartDate.toISOString(), repoId, commitUserId, 1)
      repoCommits += 1
    }

    for (const pullRequest of repoData.pullRequestsOpened) {
      const pullRequestUserId = getPullRequestUserId(pullRequest)
      if (!selectedUserIdSet.has(pullRequestUserId)) {
        continue
      }

      const openedTime = new Date(pullRequest.createdAt).valueOf()
      if (Number.isNaN(openedTime) || openedTime < rangeStartTime || openedTime > rangeEndTime) {
        continue
      }

      const bucketStartDate = getBucketStartDate(pullRequest.createdAt, granularity)
      if (!bucketStartDate) {
        continue
      }

      addToBucket(bucketPointMap.prsOpened, bucketStartDate.toISOString(), repoId, pullRequestUserId, 1)
      repoPrsOpened += 1
    }

    for (const pullRequest of repoData.pullRequests) {
      if (!pullRequest.mergedAt) {
        continue
      }

      const pullRequestUserId = getPullRequestUserId(pullRequest)
      if (!selectedUserIdSet.has(pullRequestUserId)) {
        continue
      }

      const mergedTime = new Date(pullRequest.mergedAt).valueOf()
      const createdTime = new Date(pullRequest.createdAt).valueOf()
      if (Number.isNaN(mergedTime) || Number.isNaN(createdTime) || mergedTime <= createdTime) {
        continue
      }

      if (mergedTime >= rangeStartTime && mergedTime <= rangeEndTime) {
        const bucketStartDate = getBucketStartDate(pullRequest.mergedAt, granularity)
        if (!bucketStartDate) {
          continue
        }

        addToBucket(bucketPointMap.prsMerged, bucketStartDate.toISOString(), repoId, pullRequestUserId, 1)
        repoPrsMerged += 1
      }

      if (createdTime >= rangeStartTime && createdTime <= rangeEndTime) {
        const durationDays = (mergedTime - createdTime) / (1000 * 60 * 60 * 24)
        repoMergeDurations.push(durationDays)
        globalMergeDurations.push(durationDays)
      }
    }

    for (const openedIssue of repoData.issuesOpened) {
      const issueUserId = getIssueUserId(openedIssue)
      if (!selectedUserIdSet.has(issueUserId)) {
        continue
      }

      const openedTime = new Date(openedIssue.createdAt).valueOf()
      if (Number.isNaN(openedTime) || openedTime < rangeStartTime || openedTime > rangeEndTime) {
        continue
      }

      const bucketStartDate = getBucketStartDate(openedIssue.createdAt, granularity)
      if (!bucketStartDate) {
        continue
      }

      addToBucket(bucketPointMap.issuesOpened, bucketStartDate.toISOString(), repoId, issueUserId, 1)
      repoIssuesOpened += 1
    }

    for (const closedIssue of repoData.issuesClosed) {
      if (!closedIssue.closedAt) {
        continue
      }

      const issueUserId = getIssueUserId(closedIssue)
      if (!selectedUserIdSet.has(issueUserId)) {
        continue
      }

      const closedTime = new Date(closedIssue.closedAt).valueOf()
      if (Number.isNaN(closedTime) || closedTime < rangeStartTime || closedTime > rangeEndTime) {
        continue
      }

      const bucketStartDate = getBucketStartDate(closedIssue.closedAt, granularity)
      if (!bucketStartDate) {
        continue
      }

      addToBucket(bucketPointMap.issuesClosed, bucketStartDate.toISOString(), repoId, issueUserId, 1)
      repoIssuesClosed += 1
    }

    perRepoTotals.push({
      repoId,
      repoName: repoData.repoName,
      commits: repoCommits,
      prsOpened: repoPrsOpened,
      prsMerged: repoPrsMerged,
      issuesOpened: repoIssuesOpened,
      issuesClosed: repoIssuesClosed,
      mergeTimeCount: repoMergeDurations.length,
      mergeTimeAverageDays: calculateAverage(repoMergeDurations),
      mergeTimeMedianDays: calculateMedian(repoMergeDurations),
    })
  }

  perRepoTotals.sort((left, right) => left.repoName.localeCompare(right.repoName))

  const commitsSeries = bucketTimeline
    .map((bucketStart) => bucketPointMap.commits.get(bucketStart))
    .filter((point): point is AggregatedBucketPoint => point !== undefined)
  const prsOpenedSeries = bucketTimeline
    .map((bucketStart) => bucketPointMap.prsOpened.get(bucketStart))
    .filter((point): point is AggregatedBucketPoint => point !== undefined)
  const prsMergedSeries = bucketTimeline
    .map((bucketStart) => bucketPointMap.prsMerged.get(bucketStart))
    .filter((point): point is AggregatedBucketPoint => point !== undefined)
  const issuesOpenedSeries = bucketTimeline
    .map((bucketStart) => bucketPointMap.issuesOpened.get(bucketStart))
    .filter((point): point is AggregatedBucketPoint => point !== undefined)
  const issuesClosedSeries = bucketTimeline
    .map((bucketStart) => bucketPointMap.issuesClosed.get(bucketStart))
    .filter((point): point is AggregatedBucketPoint => point !== undefined)

  return {
    range,
    granularity,
    repoIds,
    totals: {
      commits: commitsSeries.reduce((accumulator, point) => accumulator + point.total, 0),
      prsOpened: prsOpenedSeries.reduce((accumulator, point) => accumulator + point.total, 0),
      prsMerged: prsMergedSeries.reduce((accumulator, point) => accumulator + point.total, 0),
      issuesOpened: issuesOpenedSeries.reduce((accumulator, point) => accumulator + point.total, 0),
      issuesClosed: issuesClosedSeries.reduce((accumulator, point) => accumulator + point.total, 0),
    },
    mergeTime: {
      count: globalMergeDurations.length,
      averageDays: calculateAverage(globalMergeDurations),
      medianDays: calculateMedian(globalMergeDurations),
    },
    series: {
      commits: commitsSeries,
      prsOpened: prsOpenedSeries,
      prsMerged: prsMergedSeries,
      issuesOpened: issuesOpenedSeries,
      issuesClosed: issuesClosedSeries,
    },
    perRepoTotals,
  }
}

function aggregateMergeTimeTrend(
  analysisByRepo: Record<string, RepoAnalysisData>,
  repoIds: string[],
  range: RunDateRange,
  granularity: AggregationGranularity,
  selectedUserIds: string[],
): MergeTimeTrendPoint[] {
  const bucketTimeline = createBucketTimeline(range, granularity)
  const durationBuckets = new Map<string, number[]>()

  for (const bucketStart of bucketTimeline) {
    durationBuckets.set(bucketStart, [])
  }

  const rangeStartTime = new Date(range.startIso).valueOf()
  const rangeEndTime = new Date(range.endIso).valueOf()
  const selectedUserIdSet = new Set(selectedUserIds)

  for (const repoId of repoIds) {
    const repoData = analysisByRepo[repoId]
    if (!repoData) {
      continue
    }

    for (const pullRequest of repoData.pullRequests) {
      if (!pullRequest.mergedAt) {
        continue
      }

      const pullRequestUserId = getPullRequestUserId(pullRequest)
      if (!selectedUserIdSet.has(pullRequestUserId)) {
        continue
      }

      const mergedTime = new Date(pullRequest.mergedAt).valueOf()
      const createdTime = new Date(pullRequest.createdAt).valueOf()
      if (
        Number.isNaN(mergedTime) ||
        Number.isNaN(createdTime) ||
        createdTime < rangeStartTime ||
        createdTime > rangeEndTime ||
        mergedTime <= createdTime
      ) {
        continue
      }

      const bucketStartDate = getBucketStartDate(pullRequest.createdAt, granularity)
      if (!bucketStartDate) {
        continue
      }

      const bucketKey = bucketStartDate.toISOString()
      const bucketDurations = durationBuckets.get(bucketKey)
      if (!bucketDurations) {
        continue
      }

      bucketDurations.push((mergedTime - createdTime) / (1000 * 60 * 60 * 24))
    }
  }

  return bucketTimeline.map((bucketStart) => {
    const durations = durationBuckets.get(bucketStart) ?? []
    return {
      bucketStart,
      bucketLabel: formatBucketLabel(bucketStart, granularity),
      count: durations.length,
      averageDays: calculateAverage(durations),
      medianDays: calculateMedian(durations),
    }
  })
}

function buildMergeTimeTrendChartData(
  trend: MergeTimeTrendPoint[],
  rollingWindowBuckets: number,
): MergeTimeTrendChartPoint[] {
  return trend.map((point, index) => {
    const startIndex = Math.max(0, index - rollingWindowBuckets + 1)
    let weightedSum = 0
    let totalCount = 0

    for (let cursor = startIndex; cursor <= index; cursor += 1) {
      const windowPoint = trend[cursor]
      if (windowPoint.averageDays === null || windowPoint.count === 0) {
        continue
      }

      weightedSum += windowPoint.averageDays * windowPoint.count
      totalCount += windowPoint.count
    }

    return {
      ...point,
      rollingAverageDays: totalCount > 0 ? weightedSum / totalCount : null,
    }
  })
}

type ActivityChartLine = {
  dataKey: string
  label: string
  color: string
}

type ActivityChartDatum = {
  bucketStart: string
  bucketLabel: string
  total: number
  [repoSeriesKey: string]: number | string
}

type ActivitySeriesDimension = 'repo' | 'user'

function buildActivityChartData(
  series: AggregatedBucketPoint[],
  entityIds: string[],
  dimension: ActivitySeriesDimension,
): ActivityChartDatum[] {
  const seriesKeyPrefix = dimension === 'repo' ? 'repo' : 'user'

  return series.map((point) => {
    const chartPoint: ActivityChartDatum = {
      bucketStart: point.bucketStart,
      bucketLabel: point.bucketLabel,
      total: point.total,
    }

    for (const entityId of entityIds) {
      const key = `${seriesKeyPrefix}:${entityId}`
      chartPoint[key] = dimension === 'repo' ? point.byRepo[entityId] ?? 0 : point.byUser[entityId] ?? 0
    }

    return chartPoint
  })
}

function getActiveUserIdsFromSeries(series: AggregatedBucketPoint[], candidateUserIds: string[]): string[] {
  if (candidateUserIds.length === 0) {
    return []
  }

  const totalsByUser: Record<string, number> = {}
  for (const point of series) {
    for (const userId of candidateUserIds) {
      totalsByUser[userId] = (totalsByUser[userId] ?? 0) + (point.byUser[userId] ?? 0)
    }
  }

  return candidateUserIds.filter((userId) => (totalsByUser[userId] ?? 0) > 0)
}

function buildCumulativeChartData(
  data: ActivityChartDatum[],
  breakdownMode: ChartBreakdownMode,
  lines: ActivityChartLine[],
): ActivityChartDatum[] {
  const runningBySeries: Record<string, number> = {}
  let runningTotal = 0

  return data.map((point) => {
    const nextPoint: ActivityChartDatum = { ...point }

    if (breakdownMode === 'aggregate') {
      runningTotal += point.total
      nextPoint.total = runningTotal
      return nextPoint
    }

    for (const lineConfig of lines) {
      const pointValue = point[lineConfig.dataKey]
      const numericValue = typeof pointValue === 'number' ? pointValue : Number(pointValue)
      const safeValue = Number.isFinite(numericValue) ? numericValue : 0
      runningBySeries[lineConfig.dataKey] = (runningBySeries[lineConfig.dataKey] ?? 0) + safeValue
      nextPoint[lineConfig.dataKey] = runningBySeries[lineConfig.dataKey]
    }

    nextPoint.total = lines.reduce((accumulator, lineConfig) => {
      const value = nextPoint[lineConfig.dataKey]
      return accumulator + (typeof value === 'number' ? value : 0)
    }, 0)

    return nextPoint
  })
}

function ActivityLineChart({
  data,
  breakdownMode,
  chartStyle,
  lines,
  aggregateLabel,
  emptyMessage,
}: {
  data: ActivityChartDatum[]
  breakdownMode: ChartBreakdownMode
  chartStyle: ChartStyle
  lines: ActivityChartLine[]
  aggregateLabel: string
  emptyMessage: string
}) {
  if (data.length === 0) {
    return <p className="commits-chart-empty">{emptyMessage}</p>
  }

  const hasBreakdownLines = lines.length > 0
  if (breakdownMode !== 'aggregate' && !hasBreakdownLines) {
    return <p className="commits-chart-empty">No series available for this breakdown in the selected range.</p>
  }

  const showAggregate = breakdownMode === 'aggregate'
  const showCumulative = chartStyle === 'cumulative'
  const chartData = showCumulative ? buildCumulativeChartData(data, breakdownMode, lines) : data
  const resolvedAggregateLabel = showCumulative ? `${aggregateLabel} (cumulative)` : aggregateLabel

  return (
    <div className="commits-chart-canvas">
      <ResponsiveContainer width="100%" height={480}>
        {chartStyle === 'bar' ? (
          <BarChart data={chartData} margin={{ top: 10, right: 24, left: 10, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} />
            <XAxis dataKey="bucketLabel" minTickGap={28} tick={{ fill: CHART_AXIS_COLOR, fontSize: 12 }} />
            <YAxis allowDecimals={false} tick={{ fill: CHART_AXIS_COLOR, fontSize: 12 }} />
            <Tooltip
              contentStyle={{ borderRadius: 8, border: `1px solid ${CHART_TOOLTIP_BORDER}` }}
              labelStyle={{ color: CHART_TOOLTIP_LABEL, fontWeight: 700 }}
            />
            <Legend />
            {showAggregate ? (
              <Bar dataKey="total" name={resolvedAggregateLabel} fill={CHART_AGGREGATE_COLOR} />
            ) : (
              lines.map((lineConfig) => (
                <Bar
                  key={lineConfig.dataKey}
                  dataKey={lineConfig.dataKey}
                  name={lineConfig.label}
                  fill={lineConfig.color}
                  stackId="stack"
                />
              ))
            )}
          </BarChart>
        ) : chartStyle === 'cumulative' ? (
          <AreaChart data={chartData} margin={{ top: 10, right: 24, left: 10, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} />
            <XAxis dataKey="bucketLabel" minTickGap={28} tick={{ fill: CHART_AXIS_COLOR, fontSize: 12 }} />
            <YAxis allowDecimals={false} tick={{ fill: CHART_AXIS_COLOR, fontSize: 12 }} />
            <Tooltip
              contentStyle={{ borderRadius: 8, border: `1px solid ${CHART_TOOLTIP_BORDER}` }}
              labelStyle={{ color: CHART_TOOLTIP_LABEL, fontWeight: 700 }}
            />
            <Legend />
            {showAggregate ? (
              <Area
                type="monotone"
                dataKey="total"
                name={resolvedAggregateLabel}
                stroke={CHART_AGGREGATE_COLOR}
                fill={CHART_AGGREGATE_COLOR}
                fillOpacity={0.32}
                strokeWidth={2}
              />
            ) : (
              lines.map((lineConfig) => (
                <Area
                  key={lineConfig.dataKey}
                  type="monotone"
                  dataKey={lineConfig.dataKey}
                  name={lineConfig.label}
                  stroke={lineConfig.color}
                  fill={lineConfig.color}
                  fillOpacity={0.32}
                  strokeWidth={1.8}
                  stackId="stack"
                />
              ))
            )}
          </AreaChart>
        ) : (
          <LineChart data={chartData} margin={{ top: 10, right: 24, left: 10, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} />
            <XAxis dataKey="bucketLabel" minTickGap={28} tick={{ fill: CHART_AXIS_COLOR, fontSize: 12 }} />
            <YAxis allowDecimals={false} tick={{ fill: CHART_AXIS_COLOR, fontSize: 12 }} />
            <Tooltip
              contentStyle={{ borderRadius: 8, border: `1px solid ${CHART_TOOLTIP_BORDER}` }}
              labelStyle={{ color: CHART_TOOLTIP_LABEL, fontWeight: 700 }}
            />
            <Legend />
            {showAggregate ? (
              <Line
                type="monotone"
                dataKey="total"
                name={resolvedAggregateLabel}
                stroke={CHART_AGGREGATE_COLOR}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 5 }}
              />
            ) : (
              lines.map((lineConfig) => (
                <Line
                  key={lineConfig.dataKey}
                  type="monotone"
                  dataKey={lineConfig.dataKey}
                  name={lineConfig.label}
                  stroke={lineConfig.color}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              ))
            )}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}

function resolveSelectedIds(selectedIds: string[], availableIds: string[]): string[] {
  if (selectedIds.includes(NO_REPO_SELECTION)) {
    return []
  }

  const availableIdSet = new Set(availableIds)
  const validSelectedIds = selectedIds.filter((selectedId) => availableIdSet.has(selectedId))
  return validSelectedIds.length > 0 ? validSelectedIds : availableIds
}

function sanitizeSelectedIds(selectedIds: string[], availableIds: string[]): string[] {
  if (selectedIds.includes(NO_REPO_SELECTION)) {
    return [NO_REPO_SELECTION]
  }

  const availableIdSet = new Set(availableIds)
  return selectedIds.filter((selectedId) => availableIdSet.has(selectedId))
}

function MultiSelectFilterDropdown({
  options,
  selectedIds,
  onChange,
  disabled,
}: {
  options: SelectFilterOption[]
  selectedIds: string[]
  onChange: (nextIds: string[]) => void
  disabled: boolean
}) {
  const normalizedOptions: MultiSelectOption[] = useMemo(
    () =>
      options.map((option) => ({
        value: option.id,
        label: option.label,
      })),
    [options],
  )
  const dropdownOptions: MultiSelectOption[] = useMemo(
    () => [{ value: ALL_REPOS_OPTION, label: 'All', isAll: true }, ...normalizedOptions],
    [normalizedOptions],
  )
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const selectedValues = useMemo(
    () => normalizedOptions.filter((option) => selectedIdSet.has(option.value)),
    [normalizedOptions, selectedIdSet],
  )
  const allSelected = normalizedOptions.length > 0 && selectedValues.length === normalizedOptions.length
  const selectedSummary =
    normalizedOptions.length === 0 ? 'No options' : `${selectedValues.length}/${normalizedOptions.length} selected`
  const dropdownWidthCh = useMemo(() => {
    const longestLabelLength = normalizedOptions.reduce(
      (maxLength, option) => Math.max(maxLength, option.label.length),
      0,
    )
    return Math.max(18, longestLabelLength + 6)
  }, [normalizedOptions])
  const scrollbarWidthPx = 16

  function handleSelectChange(nextValue: MultiValue<MultiSelectOption>) {
    const hasAllOption = nextValue.some((option) => option.isAll)
    if (hasAllOption) {
      if (allSelected) {
        onChange([NO_REPO_SELECTION])
      } else {
        onChange(normalizedOptions.map((option) => option.value))
      }
      return
    }

    const nextIds = nextValue.filter((option) => !option.isAll).map((option) => option.value)
    if (nextIds.length === 0) {
      onChange([NO_REPO_SELECTION])
      return
    }

    onChange(nextIds.length > 0 ? nextIds : [NO_REPO_SELECTION])
  }

  function OptionRow(optionProps: OptionProps<MultiSelectOption, true>) {
    const optionData = optionProps.data
    const chosenValues = optionProps.getValue().filter((entry) => !entry.isAll)
    const totalSelectableOptions = (optionProps.options as MultiSelectOption[]).filter((entry) => !entry.isAll).length
    const isAllChecked = totalSelectableOptions > 0 && chosenValues.length === totalSelectableOptions
    const isChecked = optionData.isAll ? isAllChecked : chosenValues.some((entry) => entry.value === optionData.value)
    const isIndeterminate = Boolean(optionData.isAll && chosenValues.length > 0 && !isAllChecked)

    return (
      <components.Option {...optionProps}>
        <span className="repo-select-option">
          <input
            type="checkbox"
            checked={isChecked}
            ref={(node) => {
              if (!node) {
                return
              }

              node.indeterminate = isIndeterminate
            }}
            readOnly
          />
          <span>{optionData.label}</span>
        </span>
      </components.Option>
    )
  }

  return (
    <Select<MultiSelectOption, true>
      classNamePrefix="repo-select"
      isMulti
      closeMenuOnSelect={false}
      hideSelectedOptions={false}
      backspaceRemovesValue={false}
      isClearable={false}
      controlShouldRenderValue={false}
      tabSelectsValue={false}
      options={dropdownOptions}
      value={selectedValues}
      onChange={handleSelectChange}
      placeholder={selectedSummary}
      isDisabled={disabled || normalizedOptions.length === 0}
      styles={{
        container: (base) => ({
          ...base,
          width: `calc(${dropdownWidthCh}ch + ${scrollbarWidthPx}px)`,
          minWidth: `calc(${dropdownWidthCh}ch + ${scrollbarWidthPx}px)`,
        }),
        menu: (base) => ({
          ...base,
          width: `calc(${dropdownWidthCh}ch + ${scrollbarWidthPx}px)`,
          minWidth: `calc(${dropdownWidthCh}ch + ${scrollbarWidthPx}px)`,
        }),
      }}
      components={{
        Option: OptionRow,
        IndicatorSeparator: null,
      }}
    />
  )
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

function readThemeFromStorage(): ThemeMode {
  if (typeof window === 'undefined') {
    return 'light'
  }

  try {
    const storedTheme = localStorage.getItem(THEME_STORAGE_KEY)
    if (storedTheme === 'light' || storedTheme === 'dark') {
      return storedTheme
    }
  } catch {
    // Ignore storage read failures and use system/default fallback.
  }

  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark'
  }

  return 'light'
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
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readThemeFromStorage())
  const [token, setToken] = useState<string>(() => readTokenFromStorage())
  const [persistToken, setPersistToken] = useState<boolean>(() => readTokenFromStorage().length > 0)
  const [isTokenHelpOpen, setIsTokenHelpOpen] = useState(false)
  const [timeRangePreset, setTimeRangePreset] = useState<'30' | '90' | '365' | 'custom'>('365')
  const [customRangeStart, setCustomRangeStart] = useState<string>(() => formatDateInput(getDateDaysAgo(365)))
  const [customRangeEnd, setCustomRangeEnd] = useState<string>(() => formatDateInput(new Date()))
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
  const [, setActiveStep] = useState<RunStepKey | null>(null)
  const [stepStatuses, setStepStatuses] = useState<StepStatusMap>(() => createStepStatusMap('queued'))
  const [repoMatrixRows, setRepoMatrixRows] = useState<RepoMatrixRow[]>([])
  const [runErrors, setRunErrors] = useState<RunErrorItem[]>([])
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null)
  const [runFinishedAt, setRunFinishedAt] = useState<number | null>(null)
  const [lastRunRange, setLastRunRange] = useState<RunDateRange | null>(null)
  const [lastRunRangeLabel, setLastRunRangeLabel] = useState<string>('Last 365 days')
  const [commitsChartGranularity, setCommitsChartGranularity] = useState<AggregationGranularity>('weekly')
  const [commitsChartScopeMode, setCommitsChartScopeMode] = useState<CommitsChartScopeMode>('multi')
  const [commitsChartStyle, setCommitsChartStyle] = useState<ChartStyle>('line')
  const [commitsChartBreakdownMode, setCommitsChartBreakdownMode] = useState<ChartBreakdownMode>('aggregate')
  const [commitsChartStartDay, setCommitsChartStartDay] = useState('')
  const [commitsChartEndDay, setCommitsChartEndDay] = useState('')
  const [commitsChartSingleRepoId, setCommitsChartSingleRepoId] = useState('')
  const [commitsChartMultiRepoIds, setCommitsChartMultiRepoIds] = useState<string[]>([])
  const [commitsChartUserIds, setCommitsChartUserIds] = useState<string[]>([])
  const [prChartGranularity, setPrChartGranularity] = useState<AggregationGranularity>('weekly')
  const [prChartScopeMode, setPrChartScopeMode] = useState<CommitsChartScopeMode>('multi')
  const [prChartStyle, setPrChartStyle] = useState<ChartStyle>('line')
  const [prChartBreakdownMode, setPrChartBreakdownMode] = useState<ChartBreakdownMode>('aggregate')
  const [prChartStartDay, setPrChartStartDay] = useState('')
  const [prChartEndDay, setPrChartEndDay] = useState('')
  const [prChartSingleRepoId, setPrChartSingleRepoId] = useState('')
  const [prChartMultiRepoIds, setPrChartMultiRepoIds] = useState<string[]>([])
  const [prChartUserIds, setPrChartUserIds] = useState<string[]>([])
  const [issuesOpenedChartGranularity, setIssuesOpenedChartGranularity] = useState<AggregationGranularity>('weekly')
  const [issuesOpenedChartScopeMode, setIssuesOpenedChartScopeMode] = useState<CommitsChartScopeMode>('multi')
  const [issuesOpenedChartStyle, setIssuesOpenedChartStyle] = useState<ChartStyle>('line')
  const [issuesOpenedChartBreakdownMode, setIssuesOpenedChartBreakdownMode] = useState<ChartBreakdownMode>('aggregate')
  const [issuesOpenedChartStartDay, setIssuesOpenedChartStartDay] = useState('')
  const [issuesOpenedChartEndDay, setIssuesOpenedChartEndDay] = useState('')
  const [issuesOpenedChartSingleRepoId, setIssuesOpenedChartSingleRepoId] = useState('')
  const [issuesOpenedChartMultiRepoIds, setIssuesOpenedChartMultiRepoIds] = useState<string[]>([])
  const [issuesOpenedChartUserIds, setIssuesOpenedChartUserIds] = useState<string[]>([])
  const [issuesClosedChartGranularity, setIssuesClosedChartGranularity] = useState<AggregationGranularity>('weekly')
  const [issuesClosedChartScopeMode, setIssuesClosedChartScopeMode] = useState<CommitsChartScopeMode>('multi')
  const [issuesClosedChartStyle, setIssuesClosedChartStyle] = useState<ChartStyle>('line')
  const [issuesClosedChartBreakdownMode, setIssuesClosedChartBreakdownMode] = useState<ChartBreakdownMode>('aggregate')
  const [issuesClosedChartStartDay, setIssuesClosedChartStartDay] = useState('')
  const [issuesClosedChartEndDay, setIssuesClosedChartEndDay] = useState('')
  const [issuesClosedChartSingleRepoId, setIssuesClosedChartSingleRepoId] = useState('')
  const [issuesClosedChartMultiRepoIds, setIssuesClosedChartMultiRepoIds] = useState<string[]>([])
  const [issuesClosedChartUserIds, setIssuesClosedChartUserIds] = useState<string[]>([])
  const [cycleChartGranularity, setCycleChartGranularity] = useState<AggregationGranularity>('weekly')
  const [cycleChartScopeMode, setCycleChartScopeMode] = useState<CommitsChartScopeMode>('multi')
  const [cycleChartStartDay, setCycleChartStartDay] = useState('')
  const [cycleChartEndDay, setCycleChartEndDay] = useState('')
  const [cycleChartSingleRepoId, setCycleChartSingleRepoId] = useState('')
  const [cycleChartMultiRepoIds, setCycleChartMultiRepoIds] = useState<string[]>([])
  const [cycleChartUserIds, setCycleChartUserIds] = useState<string[]>([])
  const [cycleRollingWindow, setCycleRollingWindow] = useState<'2' | '4' | '8'>('4')
  const [globalChartGranularity, setGlobalChartGranularity] = useState<AggregationGranularity>('weekly')
  const [globalChartScopeMode, setGlobalChartScopeMode] = useState<CommitsChartScopeMode>('multi')
  const [globalChartStartDay, setGlobalChartStartDay] = useState('')
  const [globalChartEndDay, setGlobalChartEndDay] = useState('')
  const [globalChartStyle, setGlobalChartStyle] = useState<ChartStyle>('line')
  const [globalChartBreakdownMode, setGlobalChartBreakdownMode] = useState<ChartBreakdownMode>('aggregate')
  const [globalChartSingleRepoId, setGlobalChartSingleRepoId] = useState('')
  const [globalChartMultiRepoIds, setGlobalChartMultiRepoIds] = useState<string[]>([])
  const [globalChartUserIds, setGlobalChartUserIds] = useState<string[]>([])
  const [globalCycleSmoothing, setGlobalCycleSmoothing] = useState<'2' | '4' | '8'>('4')
  const [globalFiltersMessage, setGlobalFiltersMessage] = useState('')
  const [globalFiltersMessageTone, setGlobalFiltersMessageTone] = useState<'idle' | 'success' | 'error'>('idle')
  const [rateLimitSnapshot, setRateLimitSnapshot] = useState<RateLimitSnapshot | null>(null)
  const [analysisDataByRepo, setAnalysisDataByRepo] = useState<Record<string, RepoAnalysisData>>({})
  const runSequenceRef = useRef(0)
  const activeRunRef = useRef<number | null>(null)

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', themeMode)
      document.documentElement.style.colorScheme = themeMode
    }

    if (typeof window === 'undefined') {
      return
    }

    try {
      localStorage.setItem(THEME_STORAGE_KEY, themeMode)
    } catch {
      // Ignore storage write failures; theme remains active in memory.
    }
  }, [themeMode])

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

  function updateRateLimitFromResponse(response: Response) {
    const snapshot = parseRateLimitSnapshot(response)
    if (!snapshot) {
      return
    }

    setRateLimitSnapshot(snapshot)
  }

  function resolveRunDateRange():
    | { ok: true; range: RunDateRange }
    | { ok: false; message: string } {
    if (timeRangePreset === 'custom') {
      if (customRangeStart.length === 0 || customRangeEnd.length === 0) {
        return {
          ok: false,
          message: 'Choose both start and end dates for a custom range.',
        }
      }

      const startDate = new Date(`${customRangeStart}T00:00:00.000Z`)
      const endDate = new Date(`${customRangeEnd}T23:59:59.999Z`)
      if (Number.isNaN(startDate.valueOf()) || Number.isNaN(endDate.valueOf())) {
        return {
          ok: false,
          message: 'Custom range dates are invalid.',
        }
      }

      if (startDate > endDate) {
        return {
          ok: false,
          message: 'Custom range start date must be before end date.',
        }
      }

      return {
        ok: true,
        range: buildRunDateRangeFromDays(customRangeStart, customRangeEnd, `${customRangeStart} to ${customRangeEnd}`),
      }
    }

    const days = Number(timeRangePreset)
    if (!Number.isFinite(days) || days <= 0) {
      return {
        ok: false,
        message: 'Time range preset is invalid.',
      }
    }

    const endDate = new Date()
    endDate.setUTCHours(23, 59, 59, 999)
    const startDate = new Date()
    startDate.setUTCDate(startDate.getUTCDate() - days)
    startDate.setUTCHours(0, 0, 0, 0)

    return {
      ok: true,
      range: buildRunDateRangeFromDays(
        startDate.toISOString().slice(0, 10),
        endDate.toISOString().slice(0, 10),
        `Last ${days} days`,
      ),
    }
  }

  async function executeGraphQLWithRateLimit<TData>(
    trimmedToken: string,
    query: string,
    variables?: Record<string, unknown>,
  ) {
    const result = await executeGitHubGraphQL<TData>(trimmedToken, query, variables)
    updateRateLimitFromResponse(result.response)
    return result
  }

  async function validateTokenWithGitHub(trimmedToken: string): Promise<TokenValidationStatus> {
    try {
      const { response, payload } = await executeGraphQLWithRateLimit<ViewerValidationData>(trimmedToken, VIEWER_QUERY)
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
    setLastRunRange(null)
    setLastRunRangeLabel('Last 365 days')
    setCommitsChartGranularity('weekly')
    setCommitsChartScopeMode('multi')
    setCommitsChartStyle('line')
    setCommitsChartBreakdownMode('aggregate')
    setCommitsChartStartDay('')
    setCommitsChartEndDay('')
    setCommitsChartSingleRepoId('')
    setCommitsChartMultiRepoIds([])
    setCommitsChartUserIds([])
    setPrChartGranularity('weekly')
    setPrChartScopeMode('multi')
    setPrChartStyle('line')
    setPrChartBreakdownMode('aggregate')
    setPrChartStartDay('')
    setPrChartEndDay('')
    setPrChartSingleRepoId('')
    setPrChartMultiRepoIds([])
    setPrChartUserIds([])
    setIssuesOpenedChartGranularity('weekly')
    setIssuesOpenedChartScopeMode('multi')
    setIssuesOpenedChartStyle('line')
    setIssuesOpenedChartBreakdownMode('aggregate')
    setIssuesOpenedChartStartDay('')
    setIssuesOpenedChartEndDay('')
    setIssuesOpenedChartSingleRepoId('')
    setIssuesOpenedChartMultiRepoIds([])
    setIssuesOpenedChartUserIds([])
    setIssuesClosedChartGranularity('weekly')
    setIssuesClosedChartScopeMode('multi')
    setIssuesClosedChartStyle('line')
    setIssuesClosedChartBreakdownMode('aggregate')
    setIssuesClosedChartStartDay('')
    setIssuesClosedChartEndDay('')
    setIssuesClosedChartSingleRepoId('')
    setIssuesClosedChartMultiRepoIds([])
    setIssuesClosedChartUserIds([])
    setCycleChartGranularity('weekly')
    setCycleChartScopeMode('multi')
    setCycleChartStartDay('')
    setCycleChartEndDay('')
    setCycleChartSingleRepoId('')
    setCycleChartMultiRepoIds([])
    setCycleChartUserIds([])
    setCycleRollingWindow('4')
    setGlobalChartGranularity('weekly')
    setGlobalChartScopeMode('multi')
    setGlobalChartStartDay('')
    setGlobalChartEndDay('')
    setGlobalChartStyle('line')
    setGlobalChartBreakdownMode('aggregate')
    setGlobalChartSingleRepoId('')
    setGlobalChartMultiRepoIds([])
    setGlobalChartUserIds([])
    setGlobalCycleSmoothing('4')
    setGlobalFiltersMessage('')
    setGlobalFiltersMessageTone('idle')
    setRateLimitSnapshot(null)
    setAnalysisDataByRepo({})
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
  const globalFiltersMessageClassName =
    globalFiltersMessageTone === 'error'
      ? 'repo-status repo-status--error'
      : globalFiltersMessageTone === 'success'
        ? 'repo-status repo-status--success'
        : 'repo-status repo-status--idle'
  const rerunButtonLabel = runPhase === 'idle' ? 'Start Run' : 'Retry Run'
  const loadedRepoCount = Object.keys(analysisDataByRepo).length
  const loadedRepoIds = useMemo(() => Object.keys(analysisDataByRepo), [analysisDataByRepo])
  const loadedRepoOptions = useMemo(
    () =>
      loadedRepoIds
        .map((repoId) => {
          const repoData = analysisDataByRepo[repoId]
          return repoData
            ? {
                repoId,
                repoName: getRepositoryShortName(repoData.repoName),
              }
            : null
        })
        .filter((repoOption): repoOption is LoadedRepoOption => repoOption !== null)
        .sort((left, right) => left.repoName.localeCompare(right.repoName)),
    [analysisDataByRepo, loadedRepoIds],
  )
  const loadedRepoFilterOptions = useMemo<SelectFilterOption[]>(
    () =>
      loadedRepoOptions.map((repoOption) => ({
        id: repoOption.repoId,
        label: repoOption.repoName,
      })),
    [loadedRepoOptions],
  )
  const loadedUserOptions = useMemo<LoadedUserOption[]>(() => {
    const userIds = new Set<string>()
    for (const repoId of loadedRepoIds) {
      const repoData = analysisDataByRepo[repoId]
      if (!repoData) {
        continue
      }

      for (const commit of repoData.commits) {
        userIds.add(getCommitUserId(commit))
      }
      for (const pullRequest of repoData.pullRequests) {
        userIds.add(getPullRequestUserId(pullRequest))
      }
      for (const pullRequest of repoData.pullRequestsOpened) {
        userIds.add(getPullRequestUserId(pullRequest))
      }
      for (const issue of repoData.issuesOpened) {
        userIds.add(getIssueUserId(issue))
      }
      for (const issue of repoData.issuesClosed) {
        userIds.add(getIssueUserId(issue))
      }
    }

    return Array.from(userIds)
      .map((userId) => ({
        userId,
        userLabel: getUserDisplayLabel(userId),
      }))
      .sort((left, right) => left.userLabel.localeCompare(right.userLabel))
  }, [analysisDataByRepo, loadedRepoIds])
  const loadedUserIds = useMemo(() => loadedUserOptions.map((option) => option.userId), [loadedUserOptions])
  const loadedUserFilterOptions = useMemo<SelectFilterOption[]>(
    () =>
      loadedUserOptions.map((option) => ({
        id: option.userId,
        label: option.userLabel,
      })),
    [loadedUserOptions],
  )
  const userLabelById = useMemo(() => {
    const labelMap = new Map<string, string>()
    for (const option of loadedUserOptions) {
      labelMap.set(option.userId, option.userLabel)
    }
    return labelMap
  }, [loadedUserOptions])
  const globalChartMultiRepoValue = useMemo(
    () => resolveSelectedIds(globalChartMultiRepoIds, loadedRepoIds),
    [globalChartMultiRepoIds, loadedRepoIds],
  )
  const globalChartUserValue = useMemo(
    () => resolveSelectedIds(globalChartUserIds, loadedUserIds),
    [globalChartUserIds, loadedUserIds],
  )
  const commitsChartMultiRepoValue = useMemo(
    () => resolveSelectedIds(commitsChartMultiRepoIds, loadedRepoIds),
    [commitsChartMultiRepoIds, loadedRepoIds],
  )
  const commitsChartUserValue = useMemo(
    () => resolveSelectedIds(commitsChartUserIds, loadedUserIds),
    [commitsChartUserIds, loadedUserIds],
  )
  const commitsChartRepoIds = useMemo(() => {
    const effectiveSingleRepoId =
      commitsChartSingleRepoId.length > 0 && analysisDataByRepo[commitsChartSingleRepoId]
        ? commitsChartSingleRepoId
        : loadedRepoIds[0]

    if (commitsChartScopeMode === 'single') {
      return effectiveSingleRepoId ? [effectiveSingleRepoId] : []
    }

    if (commitsChartScopeMode === 'multi') {
      return commitsChartMultiRepoValue
    }

    return loadedRepoIds
  }, [analysisDataByRepo, commitsChartMultiRepoValue, commitsChartScopeMode, commitsChartSingleRepoId, loadedRepoIds])
  const commitsChartRangeResolution = useMemo(
    () => resolveChartDateRangeWithinCore(lastRunRange, commitsChartStartDay, commitsChartEndDay),
    [commitsChartEndDay, commitsChartStartDay, lastRunRange],
  )
  const commitsChartAggregation = useMemo(() => {
    if (!commitsChartRangeResolution.ok || commitsChartRepoIds.length === 0) {
      return null
    }

    return aggregateRepositoryActivity(
      analysisDataByRepo,
      commitsChartRepoIds,
      commitsChartRangeResolution.range,
      commitsChartGranularity,
      commitsChartUserValue,
    )
  }, [analysisDataByRepo, commitsChartGranularity, commitsChartRangeResolution, commitsChartRepoIds, commitsChartUserValue])
  const commitsChartRepoData = useMemo(() => {
    if (!commitsChartAggregation) {
      return [] as ActivityChartDatum[]
    }

    return buildActivityChartData(commitsChartAggregation.series.commits, commitsChartAggregation.repoIds, 'repo')
  }, [commitsChartAggregation])
  const commitsActiveUserIds = useMemo(
    () => getActiveUserIdsFromSeries(commitsChartAggregation?.series.commits ?? [], commitsChartUserValue),
    [commitsChartAggregation, commitsChartUserValue],
  )
  const commitsChartUserData = useMemo(() => {
    if (!commitsChartAggregation) {
      return [] as ActivityChartDatum[]
    }

    return buildActivityChartData(commitsChartAggregation.series.commits, commitsActiveUserIds, 'user')
  }, [commitsActiveUserIds, commitsChartAggregation])
  const commitsUnit = useMemo(() => getGranularityUnit(commitsChartGranularity), [commitsChartGranularity])
  const commitsPerTimeStats = useMemo(
    () => calculatePerTimeStats(commitsChartAggregation?.series.commits ?? []),
    [commitsChartAggregation],
  )
  const commitsRepoChartLines = useMemo(() => {
    if (!commitsChartAggregation) {
      return [] as ActivityChartLine[]
    }

    return commitsChartAggregation.repoIds.map((repoId, index) => ({
      dataKey: `repo:${repoId}`,
      label: getRepositoryShortName(analysisDataByRepo[repoId]?.repoName ?? repoId),
      color: CHART_COLORS[index % CHART_COLORS.length],
    }))
  }, [analysisDataByRepo, commitsChartAggregation])
  const commitsUserChartLines = useMemo(
    () =>
      commitsActiveUserIds.map((userId, index) => ({
        dataKey: `user:${userId}`,
        label: userLabelById.get(userId) ?? getUserDisplayLabel(userId),
        color: CHART_COLORS[index % CHART_COLORS.length],
      })),
    [commitsActiveUserIds, userLabelById],
  )
  const commitsChartData = useMemo(
    () => (commitsChartBreakdownMode === 'byUser' ? commitsChartUserData : commitsChartRepoData),
    [commitsChartBreakdownMode, commitsChartRepoData, commitsChartUserData],
  )
  const commitsChartLines = useMemo(
    () => (commitsChartBreakdownMode === 'byUser' ? commitsUserChartLines : commitsRepoChartLines),
    [commitsChartBreakdownMode, commitsRepoChartLines, commitsUserChartLines],
  )
  const prChartMultiRepoValue = useMemo(
    () => resolveSelectedIds(prChartMultiRepoIds, loadedRepoIds),
    [loadedRepoIds, prChartMultiRepoIds],
  )
  const prChartUserValue = useMemo(
    () => resolveSelectedIds(prChartUserIds, loadedUserIds),
    [loadedUserIds, prChartUserIds],
  )
  const prChartRepoIds = useMemo(() => {
    const effectiveSingleRepoId =
      prChartSingleRepoId.length > 0 && analysisDataByRepo[prChartSingleRepoId] ? prChartSingleRepoId : loadedRepoIds[0]

    if (prChartScopeMode === 'single') {
      return effectiveSingleRepoId ? [effectiveSingleRepoId] : []
    }

    if (prChartScopeMode === 'multi') {
      return prChartMultiRepoValue
    }

    return loadedRepoIds
  }, [analysisDataByRepo, loadedRepoIds, prChartMultiRepoValue, prChartScopeMode, prChartSingleRepoId])
  const prChartRangeResolution = useMemo(
    () => resolveChartDateRangeWithinCore(lastRunRange, prChartStartDay, prChartEndDay),
    [lastRunRange, prChartEndDay, prChartStartDay],
  )
  const prChartAggregation = useMemo(() => {
    if (!prChartRangeResolution.ok || prChartRepoIds.length === 0) {
      return null
    }

    return aggregateRepositoryActivity(
      analysisDataByRepo,
      prChartRepoIds,
      prChartRangeResolution.range,
      prChartGranularity,
      prChartUserValue,
    )
  }, [analysisDataByRepo, prChartGranularity, prChartRangeResolution, prChartRepoIds, prChartUserValue])
  const prMergedRepoChartData = useMemo(() => {
    if (!prChartAggregation) {
      return [] as ActivityChartDatum[]
    }

    return buildActivityChartData(prChartAggregation.series.prsMerged, prChartAggregation.repoIds, 'repo')
  }, [prChartAggregation])
  const prOpenedRepoChartData = useMemo(() => {
    if (!prChartAggregation) {
      return [] as ActivityChartDatum[]
    }

    return buildActivityChartData(prChartAggregation.series.prsOpened, prChartAggregation.repoIds, 'repo')
  }, [prChartAggregation])
  const prMergedActiveUserIds = useMemo(
    () => getActiveUserIdsFromSeries(prChartAggregation?.series.prsMerged ?? [], prChartUserValue),
    [prChartAggregation, prChartUserValue],
  )
  const prOpenedActiveUserIds = useMemo(
    () => getActiveUserIdsFromSeries(prChartAggregation?.series.prsOpened ?? [], prChartUserValue),
    [prChartAggregation, prChartUserValue],
  )
  const prMergedUserChartData = useMemo(() => {
    if (!prChartAggregation) {
      return [] as ActivityChartDatum[]
    }

    return buildActivityChartData(prChartAggregation.series.prsMerged, prMergedActiveUserIds, 'user')
  }, [prChartAggregation, prMergedActiveUserIds])
  const prOpenedUserChartData = useMemo(() => {
    if (!prChartAggregation) {
      return [] as ActivityChartDatum[]
    }

    return buildActivityChartData(prChartAggregation.series.prsOpened, prOpenedActiveUserIds, 'user')
  }, [prChartAggregation, prOpenedActiveUserIds])
  const prUnit = useMemo(() => getGranularityUnit(prChartGranularity), [prChartGranularity])
  const prOpenedPerTimeStats = useMemo(
    () => calculatePerTimeStats(prChartAggregation?.series.prsOpened ?? []),
    [prChartAggregation],
  )
  const prMergedPerTimeStats = useMemo(
    () => calculatePerTimeStats(prChartAggregation?.series.prsMerged ?? []),
    [prChartAggregation],
  )
  const prRepoChartLines = useMemo(() => {
    if (!prChartAggregation) {
      return [] as ActivityChartLine[]
    }

    return prChartAggregation.repoIds.map((repoId, index) => ({
      dataKey: `repo:${repoId}`,
      label: getRepositoryShortName(analysisDataByRepo[repoId]?.repoName ?? repoId),
      color: CHART_COLORS[index % CHART_COLORS.length],
    }))
  }, [analysisDataByRepo, prChartAggregation])
  const prMergedUserChartLines = useMemo(
    () =>
      prMergedActiveUserIds.map((userId, index) => ({
        dataKey: `user:${userId}`,
        label: userLabelById.get(userId) ?? getUserDisplayLabel(userId),
        color: CHART_COLORS[index % CHART_COLORS.length],
      })),
    [prMergedActiveUserIds, userLabelById],
  )
  const prOpenedUserChartLines = useMemo(
    () =>
      prOpenedActiveUserIds.map((userId, index) => ({
        dataKey: `user:${userId}`,
        label: userLabelById.get(userId) ?? getUserDisplayLabel(userId),
        color: CHART_COLORS[index % CHART_COLORS.length],
      })),
    [prOpenedActiveUserIds, userLabelById],
  )
  const prOpenedChartData = useMemo(
    () => (prChartBreakdownMode === 'byUser' ? prOpenedUserChartData : prOpenedRepoChartData),
    [prChartBreakdownMode, prOpenedRepoChartData, prOpenedUserChartData],
  )
  const prMergedChartData = useMemo(
    () => (prChartBreakdownMode === 'byUser' ? prMergedUserChartData : prMergedRepoChartData),
    [prChartBreakdownMode, prMergedRepoChartData, prMergedUserChartData],
  )
  const prOpenedChartLines = useMemo(
    () => (prChartBreakdownMode === 'byUser' ? prOpenedUserChartLines : prRepoChartLines),
    [prChartBreakdownMode, prOpenedUserChartLines, prRepoChartLines],
  )
  const prMergedChartLines = useMemo(
    () => (prChartBreakdownMode === 'byUser' ? prMergedUserChartLines : prRepoChartLines),
    [prChartBreakdownMode, prMergedUserChartLines, prRepoChartLines],
  )
  const issuesOpenedChartMultiRepoValue = useMemo(
    () => resolveSelectedIds(issuesOpenedChartMultiRepoIds, loadedRepoIds),
    [issuesOpenedChartMultiRepoIds, loadedRepoIds],
  )
  const issuesOpenedChartUserValue = useMemo(
    () => resolveSelectedIds(issuesOpenedChartUserIds, loadedUserIds),
    [issuesOpenedChartUserIds, loadedUserIds],
  )
  const issuesOpenedChartRepoIds = useMemo(() => {
    const effectiveSingleRepoId =
      issuesOpenedChartSingleRepoId.length > 0 && analysisDataByRepo[issuesOpenedChartSingleRepoId]
        ? issuesOpenedChartSingleRepoId
        : loadedRepoIds[0]

    if (issuesOpenedChartScopeMode === 'single') {
      return effectiveSingleRepoId ? [effectiveSingleRepoId] : []
    }

    if (issuesOpenedChartScopeMode === 'multi') {
      return issuesOpenedChartMultiRepoValue
    }

    return loadedRepoIds
  }, [
    analysisDataByRepo,
    issuesOpenedChartMultiRepoValue,
    issuesOpenedChartScopeMode,
    issuesOpenedChartSingleRepoId,
    loadedRepoIds,
  ])
  const issuesOpenedChartRangeResolution = useMemo(
    () => resolveChartDateRangeWithinCore(lastRunRange, issuesOpenedChartStartDay, issuesOpenedChartEndDay),
    [issuesOpenedChartEndDay, issuesOpenedChartStartDay, lastRunRange],
  )
  const issuesOpenedChartAggregation = useMemo(() => {
    if (!issuesOpenedChartRangeResolution.ok || issuesOpenedChartRepoIds.length === 0) {
      return null
    }

    return aggregateRepositoryActivity(
      analysisDataByRepo,
      issuesOpenedChartRepoIds,
      issuesOpenedChartRangeResolution.range,
      issuesOpenedChartGranularity,
      issuesOpenedChartUserValue,
    )
  }, [
    analysisDataByRepo,
    issuesOpenedChartGranularity,
    issuesOpenedChartRangeResolution,
    issuesOpenedChartRepoIds,
    issuesOpenedChartUserValue,
  ])
  const issuesOpenedRepoChartData = useMemo(() => {
    if (!issuesOpenedChartAggregation) {
      return [] as ActivityChartDatum[]
    }

    return buildActivityChartData(
      issuesOpenedChartAggregation.series.issuesOpened,
      issuesOpenedChartAggregation.repoIds,
      'repo',
    )
  }, [issuesOpenedChartAggregation])
  const issuesOpenedActiveUserIds = useMemo(
    () => getActiveUserIdsFromSeries(issuesOpenedChartAggregation?.series.issuesOpened ?? [], issuesOpenedChartUserValue),
    [issuesOpenedChartAggregation, issuesOpenedChartUserValue],
  )
  const issuesOpenedUserChartData = useMemo(() => {
    if (!issuesOpenedChartAggregation) {
      return [] as ActivityChartDatum[]
    }

    return buildActivityChartData(issuesOpenedChartAggregation.series.issuesOpened, issuesOpenedActiveUserIds, 'user')
  }, [issuesOpenedActiveUserIds, issuesOpenedChartAggregation])
  const issuesOpenedUnit = useMemo(() => getGranularityUnit(issuesOpenedChartGranularity), [issuesOpenedChartGranularity])
  const issuesOpenedPerTimeStats = useMemo(
    () => calculatePerTimeStats(issuesOpenedChartAggregation?.series.issuesOpened ?? []),
    [issuesOpenedChartAggregation],
  )
  const issuesOpenedRepoChartLines = useMemo(() => {
    if (!issuesOpenedChartAggregation) {
      return [] as ActivityChartLine[]
    }

    return issuesOpenedChartAggregation.repoIds.map((repoId, index) => ({
      dataKey: `repo:${repoId}`,
      label: getRepositoryShortName(analysisDataByRepo[repoId]?.repoName ?? repoId),
      color: CHART_COLORS[index % CHART_COLORS.length],
    }))
  }, [analysisDataByRepo, issuesOpenedChartAggregation])
  const issuesOpenedUserChartLines = useMemo(
    () =>
      issuesOpenedActiveUserIds.map((userId, index) => ({
        dataKey: `user:${userId}`,
        label: userLabelById.get(userId) ?? getUserDisplayLabel(userId),
        color: CHART_COLORS[index % CHART_COLORS.length],
      })),
    [issuesOpenedActiveUserIds, userLabelById],
  )
  const issuesOpenedChartData = useMemo(
    () => (issuesOpenedChartBreakdownMode === 'byUser' ? issuesOpenedUserChartData : issuesOpenedRepoChartData),
    [issuesOpenedChartBreakdownMode, issuesOpenedRepoChartData, issuesOpenedUserChartData],
  )
  const issuesOpenedChartLines = useMemo(
    () => (issuesOpenedChartBreakdownMode === 'byUser' ? issuesOpenedUserChartLines : issuesOpenedRepoChartLines),
    [issuesOpenedChartBreakdownMode, issuesOpenedRepoChartLines, issuesOpenedUserChartLines],
  )
  const issuesClosedChartMultiRepoValue = useMemo(
    () => resolveSelectedIds(issuesClosedChartMultiRepoIds, loadedRepoIds),
    [issuesClosedChartMultiRepoIds, loadedRepoIds],
  )
  const issuesClosedChartUserValue = useMemo(
    () => resolveSelectedIds(issuesClosedChartUserIds, loadedUserIds),
    [issuesClosedChartUserIds, loadedUserIds],
  )
  const issuesClosedChartRepoIds = useMemo(() => {
    const effectiveSingleRepoId =
      issuesClosedChartSingleRepoId.length > 0 && analysisDataByRepo[issuesClosedChartSingleRepoId]
        ? issuesClosedChartSingleRepoId
        : loadedRepoIds[0]

    if (issuesClosedChartScopeMode === 'single') {
      return effectiveSingleRepoId ? [effectiveSingleRepoId] : []
    }

    if (issuesClosedChartScopeMode === 'multi') {
      return issuesClosedChartMultiRepoValue
    }

    return loadedRepoIds
  }, [
    analysisDataByRepo,
    issuesClosedChartMultiRepoValue,
    issuesClosedChartScopeMode,
    issuesClosedChartSingleRepoId,
    loadedRepoIds,
  ])
  const issuesClosedChartRangeResolution = useMemo(
    () => resolveChartDateRangeWithinCore(lastRunRange, issuesClosedChartStartDay, issuesClosedChartEndDay),
    [issuesClosedChartEndDay, issuesClosedChartStartDay, lastRunRange],
  )
  const issuesClosedChartAggregation = useMemo(() => {
    if (!issuesClosedChartRangeResolution.ok || issuesClosedChartRepoIds.length === 0) {
      return null
    }

    return aggregateRepositoryActivity(
      analysisDataByRepo,
      issuesClosedChartRepoIds,
      issuesClosedChartRangeResolution.range,
      issuesClosedChartGranularity,
      issuesClosedChartUserValue,
    )
  }, [
    analysisDataByRepo,
    issuesClosedChartGranularity,
    issuesClosedChartRangeResolution,
    issuesClosedChartRepoIds,
    issuesClosedChartUserValue,
  ])
  const issuesClosedRepoChartData = useMemo(() => {
    if (!issuesClosedChartAggregation) {
      return [] as ActivityChartDatum[]
    }

    return buildActivityChartData(
      issuesClosedChartAggregation.series.issuesClosed,
      issuesClosedChartAggregation.repoIds,
      'repo',
    )
  }, [issuesClosedChartAggregation])
  const issuesClosedActiveUserIds = useMemo(
    () => getActiveUserIdsFromSeries(issuesClosedChartAggregation?.series.issuesClosed ?? [], issuesClosedChartUserValue),
    [issuesClosedChartAggregation, issuesClosedChartUserValue],
  )
  const issuesClosedUserChartData = useMemo(() => {
    if (!issuesClosedChartAggregation) {
      return [] as ActivityChartDatum[]
    }

    return buildActivityChartData(issuesClosedChartAggregation.series.issuesClosed, issuesClosedActiveUserIds, 'user')
  }, [issuesClosedActiveUserIds, issuesClosedChartAggregation])
  const issuesClosedUnit = useMemo(() => getGranularityUnit(issuesClosedChartGranularity), [issuesClosedChartGranularity])
  const issuesClosedPerTimeStats = useMemo(
    () => calculatePerTimeStats(issuesClosedChartAggregation?.series.issuesClosed ?? []),
    [issuesClosedChartAggregation],
  )
  const issuesClosedRepoChartLines = useMemo(() => {
    if (!issuesClosedChartAggregation) {
      return [] as ActivityChartLine[]
    }

    return issuesClosedChartAggregation.repoIds.map((repoId, index) => ({
      dataKey: `repo:${repoId}`,
      label: getRepositoryShortName(analysisDataByRepo[repoId]?.repoName ?? repoId),
      color: CHART_COLORS[index % CHART_COLORS.length],
    }))
  }, [analysisDataByRepo, issuesClosedChartAggregation])
  const issuesClosedUserChartLines = useMemo(
    () =>
      issuesClosedActiveUserIds.map((userId, index) => ({
        dataKey: `user:${userId}`,
        label: userLabelById.get(userId) ?? getUserDisplayLabel(userId),
        color: CHART_COLORS[index % CHART_COLORS.length],
      })),
    [issuesClosedActiveUserIds, userLabelById],
  )
  const issuesClosedChartData = useMemo(
    () => (issuesClosedChartBreakdownMode === 'byUser' ? issuesClosedUserChartData : issuesClosedRepoChartData),
    [issuesClosedChartBreakdownMode, issuesClosedRepoChartData, issuesClosedUserChartData],
  )
  const issuesClosedChartLines = useMemo(
    () => (issuesClosedChartBreakdownMode === 'byUser' ? issuesClosedUserChartLines : issuesClosedRepoChartLines),
    [issuesClosedChartBreakdownMode, issuesClosedRepoChartLines, issuesClosedUserChartLines],
  )
  const cycleChartMultiRepoValue = useMemo(
    () => resolveSelectedIds(cycleChartMultiRepoIds, loadedRepoIds),
    [cycleChartMultiRepoIds, loadedRepoIds],
  )
  const cycleChartUserValue = useMemo(
    () => resolveSelectedIds(cycleChartUserIds, loadedUserIds),
    [cycleChartUserIds, loadedUserIds],
  )
  const cycleChartRepoIds = useMemo(() => {
    const effectiveSingleRepoId =
      cycleChartSingleRepoId.length > 0 && analysisDataByRepo[cycleChartSingleRepoId]
        ? cycleChartSingleRepoId
        : loadedRepoIds[0]

    if (cycleChartScopeMode === 'single') {
      return effectiveSingleRepoId ? [effectiveSingleRepoId] : []
    }

    if (cycleChartScopeMode === 'multi') {
      return cycleChartMultiRepoValue
    }

    return loadedRepoIds
  }, [analysisDataByRepo, cycleChartMultiRepoValue, cycleChartScopeMode, cycleChartSingleRepoId, loadedRepoIds])
  const cycleChartRangeResolution = useMemo(
    () => resolveChartDateRangeWithinCore(lastRunRange, cycleChartStartDay, cycleChartEndDay),
    [cycleChartEndDay, cycleChartStartDay, lastRunRange],
  )
  const cycleChartAggregation = useMemo(() => {
    if (!cycleChartRangeResolution.ok || cycleChartRepoIds.length === 0) {
      return null
    }

    return aggregateRepositoryActivity(
      analysisDataByRepo,
      cycleChartRepoIds,
      cycleChartRangeResolution.range,
      cycleChartGranularity,
      cycleChartUserValue,
    )
  }, [analysisDataByRepo, cycleChartGranularity, cycleChartRangeResolution, cycleChartRepoIds, cycleChartUserValue])
  const cycleMergeTimeTrend = useMemo(() => {
    if (!cycleChartRangeResolution.ok || cycleChartRepoIds.length === 0) {
      return [] as MergeTimeTrendPoint[]
    }

    return aggregateMergeTimeTrend(
      analysisDataByRepo,
      cycleChartRepoIds,
      cycleChartRangeResolution.range,
      cycleChartGranularity,
      cycleChartUserValue,
    )
  }, [analysisDataByRepo, cycleChartGranularity, cycleChartRangeResolution, cycleChartRepoIds, cycleChartUserValue])
  const cycleRollingWindowSize = Number(cycleRollingWindow)
  const cycleMergeTimeTrendData = useMemo(
    () => buildMergeTimeTrendChartData(cycleMergeTimeTrend, cycleRollingWindowSize),
    [cycleMergeTimeTrend, cycleRollingWindowSize],
  )
  const cycleUnit = useMemo(() => getGranularityUnit(cycleChartGranularity), [cycleChartGranularity])
  const cyclePerTimeStats = useMemo(
    () => calculatePerTimeStats(cycleChartAggregation?.series.prsMerged ?? []),
    [cycleChartAggregation],
  )

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

  function handleApplyGlobalFilters() {
    const rangeResolution = resolveChartDateRangeWithinCore(lastRunRange, globalChartStartDay, globalChartEndDay)
    if (!rangeResolution.ok) {
      setGlobalFiltersMessageTone('error')
      setGlobalFiltersMessage(rangeResolution.message)
      return
    }

    const validMultiRepoIds = sanitizeSelectedIds(globalChartMultiRepoIds, loadedRepoIds)
    const validUserIds = sanitizeSelectedIds(globalChartUserIds, loadedUserIds)

    setCommitsChartGranularity(globalChartGranularity)
    setCommitsChartScopeMode(globalChartScopeMode)
    setCommitsChartStartDay(globalChartStartDay)
    setCommitsChartEndDay(globalChartEndDay)
    setCommitsChartStyle(globalChartStyle)
    setCommitsChartBreakdownMode(globalChartBreakdownMode)
    setCommitsChartSingleRepoId(globalChartSingleRepoId)
    setCommitsChartMultiRepoIds(validMultiRepoIds)
    setCommitsChartUserIds(validUserIds)

    setPrChartGranularity(globalChartGranularity)
    setPrChartScopeMode(globalChartScopeMode)
    setPrChartStartDay(globalChartStartDay)
    setPrChartEndDay(globalChartEndDay)
    setPrChartStyle(globalChartStyle)
    setPrChartBreakdownMode(globalChartBreakdownMode)
    setPrChartSingleRepoId(globalChartSingleRepoId)
    setPrChartMultiRepoIds(validMultiRepoIds)
    setPrChartUserIds(validUserIds)

    setIssuesOpenedChartGranularity(globalChartGranularity)
    setIssuesOpenedChartScopeMode(globalChartScopeMode)
    setIssuesOpenedChartStartDay(globalChartStartDay)
    setIssuesOpenedChartEndDay(globalChartEndDay)
    setIssuesOpenedChartStyle(globalChartStyle)
    setIssuesOpenedChartBreakdownMode(globalChartBreakdownMode)
    setIssuesOpenedChartSingleRepoId(globalChartSingleRepoId)
    setIssuesOpenedChartMultiRepoIds(validMultiRepoIds)
    setIssuesOpenedChartUserIds(validUserIds)

    setIssuesClosedChartGranularity(globalChartGranularity)
    setIssuesClosedChartScopeMode(globalChartScopeMode)
    setIssuesClosedChartStartDay(globalChartStartDay)
    setIssuesClosedChartEndDay(globalChartEndDay)
    setIssuesClosedChartStyle(globalChartStyle)
    setIssuesClosedChartBreakdownMode(globalChartBreakdownMode)
    setIssuesClosedChartSingleRepoId(globalChartSingleRepoId)
    setIssuesClosedChartMultiRepoIds(validMultiRepoIds)
    setIssuesClosedChartUserIds(validUserIds)

    setCycleChartGranularity(globalChartGranularity)
    setCycleChartScopeMode(globalChartScopeMode)
    setCycleChartStartDay(globalChartStartDay)
    setCycleChartEndDay(globalChartEndDay)
    setCycleChartSingleRepoId(globalChartSingleRepoId)
    setCycleChartMultiRepoIds(validMultiRepoIds)
    setCycleChartUserIds(validUserIds)
    setCycleRollingWindow(globalCycleSmoothing)

    setGlobalFiltersMessageTone('success')
    setGlobalFiltersMessage('Applied filters to all chart sections.')
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

  function addRunError(errorItem: RunErrorItem) {
    setRunErrors((previous) => [...previous, errorItem])
  }

  function isRunActive(runId: number): boolean {
    return activeRunRef.current === runId
  }

  async function fetchDefaultBranchForRepo(trimmedToken: string, repoNameWithOwner: string): Promise<string> {
    const parsedName = splitRepositoryName(repoNameWithOwner)
    if (!parsedName) {
      throw new Error(`Repository name is invalid: ${repoNameWithOwner}`)
    }

    const { response, payload } = await executeGraphQLWithRateLimit<RepositoryDefaultBranchData>(
      trimmedToken,
      REPOSITORY_DEFAULT_BRANCH_QUERY,
      {
        owner: parsedName.owner,
        name: parsedName.name,
      },
    )

    const requestError = getGraphQLRequestError(response, payload)
    if (requestError) {
      throw new Error(requestError)
    }

    const defaultBranch = payload?.data?.repository?.defaultBranchRef?.name
    if (!defaultBranch) {
      throw new Error('Default branch could not be resolved for repository.')
    }

    return defaultBranch
  }

  async function fetchPullRequestsForRepo(
    trimmedToken: string,
    repoNameWithOwner: string,
    range: RunDateRange,
    mode: 'merged' | 'opened',
  ): Promise<RawPullRequestRecord[]> {
    const pullRequests: RawPullRequestRecord[] = []
    let cursor: string | null = null
    let hasNextPage = true
    const searchQuery =
      mode === 'merged'
        ? `repo:${repoNameWithOwner} is:pr is:merged merged:${range.startDay}..${range.endDay} sort:updated-desc`
        : `repo:${repoNameWithOwner} is:pr created:${range.startDay}..${range.endDay} sort:updated-desc`

    while (hasNextPage) {
      const queryResult: { response: Response; payload: GitHubGraphQLResponse<SearchPullRequestsData> | null } =
        await executeGraphQLWithRateLimit<SearchPullRequestsData>(trimmedToken, SEARCH_PULL_REQUESTS_QUERY, {
          searchQuery,
          cursor,
        })
      const response = queryResult.response
      const payload = queryResult.payload

      const requestError = getGraphQLRequestError(response, payload)
      if (requestError) {
        throw new Error(requestError)
      }

      const searchResult = payload?.data?.search as SearchPullRequestConnection | undefined
      if (!searchResult) {
        throw new Error('Search response for pull requests was missing.')
      }

      const nodes = searchResult.nodes ?? []
      for (const node of nodes) {
        if (!node) {
          continue
        }

        pullRequests.push({
          id: node.id,
          number: node.number,
          title: node.title,
          url: node.url,
          createdAt: node.createdAt,
          mergedAt: node.mergedAt,
          isDraft: node.isDraft ?? false,
          authorLogin: node.author?.login,
        })
      }

      hasNextPage = searchResult.pageInfo?.hasNextPage === true
      cursor = searchResult.pageInfo?.endCursor ?? null
    }

    return pullRequests
  }

  async function fetchIssuesForRepo(
    trimmedToken: string,
    repoNameWithOwner: string,
    range: RunDateRange,
    mode: 'opened' | 'closed',
  ): Promise<RawIssueRecord[]> {
    const issues: RawIssueRecord[] = []
    let cursor: string | null = null
    let hasNextPage = true
    const qualifier =
      mode === 'opened' ? `created:${range.startDay}..${range.endDay}` : `is:closed closed:${range.startDay}..${range.endDay}`
    const searchQuery = `repo:${repoNameWithOwner} is:issue ${qualifier} sort:updated-desc`

    while (hasNextPage) {
      const queryResult: { response: Response; payload: GitHubGraphQLResponse<SearchIssuesData> | null } =
        await executeGraphQLWithRateLimit<SearchIssuesData>(trimmedToken, SEARCH_ISSUES_QUERY, {
          searchQuery,
          cursor,
        })
      const response = queryResult.response
      const payload = queryResult.payload

      const requestError = getGraphQLRequestError(response, payload)
      if (requestError) {
        throw new Error(requestError)
      }

      const searchResult = payload?.data?.search as SearchIssuesConnection | undefined
      if (!searchResult) {
        throw new Error('Search response for issues was missing.')
      }

      const nodes = searchResult.nodes ?? []
      for (const node of nodes) {
        if (!node) {
          continue
        }

        issues.push({
          id: node.id,
          number: node.number,
          title: node.title,
          url: node.url,
          createdAt: node.createdAt,
          closedAt: node.closedAt,
          authorLogin: node.author?.login,
        })
      }

      hasNextPage = searchResult.pageInfo?.hasNextPage === true
      cursor = searchResult.pageInfo?.endCursor ?? null
    }

    return issues
  }

  async function fetchCommitsForRepo(
    trimmedToken: string,
    repoNameWithOwner: string,
    defaultBranch: string,
    range: RunDateRange,
  ): Promise<RawCommitRecord[]> {
    const parsedName = splitRepositoryName(repoNameWithOwner)
    if (!parsedName) {
      throw new Error(`Repository name is invalid: ${repoNameWithOwner}`)
    }

    const commits: RawCommitRecord[] = []
    let cursor: string | null = null
    let hasNextPage = true
    const qualifiedName = `refs/heads/${defaultBranch}`

    while (hasNextPage) {
      const queryResult: { response: Response; payload: GitHubGraphQLResponse<RepositoryCommitsData> | null } =
        await executeGraphQLWithRateLimit<RepositoryCommitsData>(trimmedToken, REPOSITORY_COMMITS_QUERY, {
          owner: parsedName.owner,
          name: parsedName.name,
          qualifiedName,
          cursor,
          since: range.startIso,
          until: range.endIso,
        })
      const response = queryResult.response
      const payload = queryResult.payload

      const requestError = getGraphQLRequestError(response, payload)
      if (requestError) {
        throw new Error(requestError)
      }

      const history = payload?.data?.repository?.ref?.target?.history as CommitHistoryConnection | undefined
      if (!history) {
        throw new Error('Commit history was not available for default branch.')
      }

      const nodes = history.nodes ?? []
      for (const node of nodes) {
        if (!node) {
          continue
        }

        commits.push({
          oid: node.oid,
          authoredDate: node.authoredDate,
          committedDate: node.committedDate,
          url: node.url,
          authorLogin: node.author?.user?.login ?? undefined,
          authorName: node.author?.name ?? undefined,
        })
      }

      hasNextPage = history.pageInfo?.hasNextPage === true
      cursor = history.pageInfo?.endCursor ?? null
    }

    return commits
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

    const resolvedRange = resolveRunDateRange()
    if (!resolvedRange.ok) {
      setRepoDiscoveryStatus({
        state: 'error',
        message: resolvedRange.message,
      })
      return
    }

    const runRange = resolvedRange.range
    const runId = runSequenceRef.current + 1
    runSequenceRef.current = runId
    activeRunRef.current = runId
    const runStarted = Date.now()
    let hasAnyErrors = false
    const nextRawAnalysisByRepo: Record<string, RepoRawAnalysisData> = {}
    for (const repository of selectedRepos) {
      nextRawAnalysisByRepo[repository.id] = {
        repoId: repository.id,
        repoName: repository.nameWithOwner,
        pullRequests: [],
        pullRequestsOpened: [],
        issuesOpened: [],
        issuesClosed: [],
        commits: [],
      }
    }

    setCurrentRunId(runId)
    setRunPhase('running')
    setActiveStep(null)
    setRunErrors([])
    setRunStartedAt(runStarted)
    setRunFinishedAt(null)
    setLastRunRange(runRange)
    setLastRunRangeLabel(runRange.label)
    setCommitsChartStartDay(runRange.startDay)
    setCommitsChartEndDay(runRange.endDay)
    setPrChartStartDay(runRange.startDay)
    setPrChartEndDay(runRange.endDay)
    setIssuesOpenedChartStartDay(runRange.startDay)
    setIssuesOpenedChartEndDay(runRange.endDay)
    setIssuesClosedChartStartDay(runRange.startDay)
    setIssuesClosedChartEndDay(runRange.endDay)
    setCycleChartStartDay(runRange.startDay)
    setCycleChartEndDay(runRange.endDay)
    setGlobalChartStartDay(runRange.startDay)
    setGlobalChartEndDay(runRange.endDay)
    setGlobalFiltersMessage('')
    setGlobalFiltersMessageTone('idle')
    setStepStatuses(createStepStatusMap('queued'))
    setAnalysisDataByRepo({})
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
    let repoPrepHasErrors = false
    for (const repository of selectedRepos) {
      if (!isRunActive(runId)) {
        return
      }

      setRepoDataStatus(repository.id, 'defaultBranch', 'fetching')
      try {
        const defaultBranch = await fetchDefaultBranchForRepo(trimmedToken, repository.nameWithOwner)
        if (!isRunActive(runId)) {
          return
        }

        nextRawAnalysisByRepo[repository.id].defaultBranch = defaultBranch
        setRepoDataStatus(repository.id, 'defaultBranch', 'done')
      } catch (error) {
        repoPrepHasErrors = true
        hasAnyErrors = true
        const message = error instanceof Error ? error.message : 'Failed to resolve default branch.'
        setRepoDataStatus(repository.id, 'defaultBranch', 'error')
        addRunError({
          step: 'repoPrep',
          repoId: repository.id,
          repoName: repository.nameWithOwner,
          dataKey: 'defaultBranch',
          message,
        })
      }
    }
    setStepStatus('repoPrep', repoPrepHasErrors ? 'error' : 'done')

    setActiveStep('prs')
    setStepStatus('prs', 'fetching')
    let prStepHasErrors = false
    for (const repository of selectedRepos) {
      if (!isRunActive(runId)) {
        return
      }

      setRepoDataStatus(repository.id, 'prs', 'fetching')
      try {
        const pullRequests = await fetchPullRequestsForRepo(trimmedToken, repository.nameWithOwner, runRange, 'merged')
        if (!isRunActive(runId)) {
          return
        }
        const pullRequestsOpened = await fetchPullRequestsForRepo(
          trimmedToken,
          repository.nameWithOwner,
          runRange,
          'opened',
        )
        if (!isRunActive(runId)) {
          return
        }

        nextRawAnalysisByRepo[repository.id].pullRequests = pullRequests
        nextRawAnalysisByRepo[repository.id].pullRequestsOpened = pullRequestsOpened
        setRepoDataStatus(repository.id, 'prs', 'done')
      } catch (error) {
        prStepHasErrors = true
        hasAnyErrors = true
        const message = error instanceof Error ? error.message : 'Failed to fetch pull requests.'
        setRepoDataStatus(repository.id, 'prs', 'error')
        addRunError({
          step: 'prs',
          repoId: repository.id,
          repoName: repository.nameWithOwner,
          dataKey: 'prs',
          message,
        })
      }
    }
    setStepStatus('prs', prStepHasErrors ? 'error' : 'done')

    setActiveStep('issues')
    setStepStatus('issues', 'fetching')
    let issuesStepHasErrors = false
    for (const repository of selectedRepos) {
      if (!isRunActive(runId)) {
        return
      }

      setRepoDataStatus(repository.id, 'issues', 'fetching')
      try {
        const openedIssues = await fetchIssuesForRepo(trimmedToken, repository.nameWithOwner, runRange, 'opened')
        if (!isRunActive(runId)) {
          return
        }
        const closedIssues = await fetchIssuesForRepo(trimmedToken, repository.nameWithOwner, runRange, 'closed')
        if (!isRunActive(runId)) {
          return
        }

        nextRawAnalysisByRepo[repository.id].issuesOpened = openedIssues
        nextRawAnalysisByRepo[repository.id].issuesClosed = closedIssues
        setRepoDataStatus(repository.id, 'issues', 'done')
      } catch (error) {
        issuesStepHasErrors = true
        hasAnyErrors = true
        const message = error instanceof Error ? error.message : 'Failed to fetch issues.'
        setRepoDataStatus(repository.id, 'issues', 'error')
        addRunError({
          step: 'issues',
          repoId: repository.id,
          repoName: repository.nameWithOwner,
          dataKey: 'issues',
          message,
        })
      }
    }
    setStepStatus('issues', issuesStepHasErrors ? 'error' : 'done')

    setActiveStep('commits')
    setStepStatus('commits', 'fetching')
    let commitsStepHasErrors = false
    for (const repository of selectedRepos) {
      if (!isRunActive(runId)) {
        return
      }

      setRepoDataStatus(repository.id, 'commits', 'fetching')
      const defaultBranch = nextRawAnalysisByRepo[repository.id].defaultBranch
      if (!defaultBranch) {
        commitsStepHasErrors = true
        hasAnyErrors = true
        setRepoDataStatus(repository.id, 'commits', 'error')
        addRunError({
          step: 'commits',
          repoId: repository.id,
          repoName: repository.nameWithOwner,
          dataKey: 'commits',
          message: 'Cannot fetch commits because default branch was not resolved.',
        })
        continue
      }

      try {
        const commits = await fetchCommitsForRepo(trimmedToken, repository.nameWithOwner, defaultBranch, runRange)
        if (!isRunActive(runId)) {
          return
        }

        nextRawAnalysisByRepo[repository.id].commits = commits
        setRepoDataStatus(repository.id, 'commits', 'done')
      } catch (error) {
        commitsStepHasErrors = true
        hasAnyErrors = true
        const message = error instanceof Error ? error.message : 'Failed to fetch commits.'
        setRepoDataStatus(repository.id, 'commits', 'error')
        addRunError({
          step: 'commits',
          repoId: repository.id,
          repoName: repository.nameWithOwner,
          dataKey: 'commits',
          message,
        })
      }
    }
    setStepStatus('commits', commitsStepHasErrors ? 'error' : 'done')

    setActiveStep('aggregate')
    setStepStatus('aggregate', 'fetching')
    if (!isRunActive(runId)) {
      return
    }

    const normalizedAnalysisByRepo: Record<string, RepoAnalysisData> = {}
    for (const repository of selectedRepos) {
      const rawRepoData = nextRawAnalysisByRepo[repository.id]
      if (!rawRepoData) {
        continue
      }

      normalizedAnalysisByRepo[repository.id] = normalizeRepositoryAnalysisData(rawRepoData)
    }

    setAnalysisDataByRepo(normalizedAnalysisByRepo)
    setStepStatus('aggregate', 'done')

    setRunPhase(hasAnyErrors ? 'partial' : 'done')
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
          <div className="brand-panel-header">
            <div className="brand">
              <img src="/logo.png" alt="Git Activity Analyzer logo" className="brand-logo" />
              <div>
                <h1>Git Activity Analyzer</h1>
                <p>Analyze multi-repo GitHub activity in one run.</p>
              </div>
            </div>
            <button
              type="button"
              className="text-button"
              onClick={() => setThemeMode((previous) => (previous === 'light' ? 'dark' : 'light'))}
            >
              {themeMode === 'light' ? 'Dark Mode' : 'Light Mode'}
            </button>
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
                  setLastRunRange(null)
                  setLastRunRangeLabel('Last 365 days')
                  setCommitsChartGranularity('weekly')
                  setCommitsChartScopeMode('multi')
                  setCommitsChartStyle('line')
                  setCommitsChartBreakdownMode('aggregate')
                  setCommitsChartStartDay('')
                  setCommitsChartEndDay('')
                  setCommitsChartSingleRepoId('')
                  setCommitsChartMultiRepoIds([])
                  setCommitsChartUserIds([])
                  setPrChartGranularity('weekly')
                  setPrChartScopeMode('multi')
                  setPrChartStyle('line')
                  setPrChartBreakdownMode('aggregate')
                  setPrChartStartDay('')
                  setPrChartEndDay('')
                  setPrChartSingleRepoId('')
                  setPrChartMultiRepoIds([])
                  setPrChartUserIds([])
                  setIssuesOpenedChartGranularity('weekly')
                  setIssuesOpenedChartScopeMode('multi')
                  setIssuesOpenedChartStyle('line')
                  setIssuesOpenedChartBreakdownMode('aggregate')
                  setIssuesOpenedChartStartDay('')
                  setIssuesOpenedChartEndDay('')
                  setIssuesOpenedChartSingleRepoId('')
                  setIssuesOpenedChartMultiRepoIds([])
                  setIssuesOpenedChartUserIds([])
                  setIssuesClosedChartGranularity('weekly')
                  setIssuesClosedChartScopeMode('multi')
                  setIssuesClosedChartStyle('line')
                  setIssuesClosedChartBreakdownMode('aggregate')
                  setIssuesClosedChartStartDay('')
                  setIssuesClosedChartEndDay('')
                  setIssuesClosedChartSingleRepoId('')
                  setIssuesClosedChartMultiRepoIds([])
                  setIssuesClosedChartUserIds([])
                  setCycleChartGranularity('weekly')
                  setCycleChartScopeMode('multi')
                  setCycleChartStartDay('')
                  setCycleChartEndDay('')
                  setCycleChartSingleRepoId('')
                  setCycleChartMultiRepoIds([])
                  setCycleChartUserIds([])
                  setCycleRollingWindow('4')
                  setGlobalChartGranularity('weekly')
                  setGlobalChartScopeMode('multi')
                  setGlobalChartStartDay('')
                  setGlobalChartEndDay('')
                  setGlobalChartStyle('line')
                  setGlobalChartBreakdownMode('aggregate')
                  setGlobalChartSingleRepoId('')
                  setGlobalChartMultiRepoIds([])
                  setGlobalChartUserIds([])
                  setGlobalCycleSmoothing('4')
                  setGlobalFiltersMessage('')
                  setGlobalFiltersMessageTone('idle')
                  setRateLimitSnapshot(null)
                  setAnalysisDataByRepo({})
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
              <select
                value={timeRangePreset}
                onChange={(event) => setTimeRangePreset(event.target.value as '30' | '90' | '365' | 'custom')}
                disabled={isRunInProgress}
              >
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
                <option value="365">Last 365 days</option>
                <option value="custom">Custom range</option>
              </select>
            </label>
            {timeRangePreset === 'custom' && (
              <label className="control-field">
                <span>Custom Start</span>
                <input
                  type="date"
                  value={customRangeStart}
                  onChange={(event) => setCustomRangeStart(event.target.value)}
                  disabled={isRunInProgress}
                />
              </label>
            )}
            {timeRangePreset === 'custom' && (
              <label className="control-field">
                <span>Custom End</span>
                <input
                  type="date"
                  value={customRangeEnd}
                  onChange={(event) => setCustomRangeEnd(event.target.value)}
                  disabled={isRunInProgress}
                />
              </label>
            )}
            <label className="control-field">
              <span>Owner Filter</span>
              <select
                value={ownerFilter}
                onChange={(event) => setOwnerFilter(event.target.value)}
                disabled={availableOwners.length === 0 || isRunInProgress}
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
                disabled={discoveredRepos.length === 0 || isRunInProgress}
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
                          disabled={isRunInProgress}
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
          <p>Selected Repos: {selectedRepos.length}</p>
          <p>Loaded Data Repos: {loadedRepoCount}</p>
          <p>Range: {lastRunRangeLabel}</p>
          <p>Duration: {runDurationMs === null ? '-' : `${Math.max(1, Math.round(runDurationMs / 1000))}s`}</p>
        </div>

        <div className="rate-limit-panel">
          <h3>Rate Limit</h3>
          {rateLimitSnapshot ? (
            <p>
              Remaining {rateLimitSnapshot.remaining}/{rateLimitSnapshot.limit} · Used {rateLimitSnapshot.used} ·
              Reset {new Date(rateLimitSnapshot.resetAt).toLocaleString()}
            </p>
          ) : (
            <p>Rate limit details will appear after GitHub requests start.</p>
          )}
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
                  <strong>{RUN_STEPS.find((step) => step.key === errorItem.step)?.label}:</strong>{' '}
                  {errorItem.repoName ? `${errorItem.repoName} · ` : ''}
                  {errorItem.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="endpoint-note">
          GraphQL endpoint: {GITHUB_GRAPHQL_ENDPOINT} · REST endpoint: {GITHUB_REST_ENDPOINT}
        </p>
      </section>

      <section className="panel global-filters-panel">
        <div className="aggregation-preview-header">
          <h3>Apply Filters To All Charts</h3>
          <button type="button" onClick={handleApplyGlobalFilters} disabled={loadedRepoCount === 0 || !lastRunRange}>
            Apply Filters
          </button>
        </div>
        <div className="aggregation-controls">
          <label>
            Granularity
            <select
              value={globalChartGranularity}
              onChange={(event) => setGlobalChartGranularity(event.target.value as AggregationGranularity)}
              disabled={loadedRepoCount === 0}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          <label>
            Repositories
            <MultiSelectFilterDropdown
              options={loadedRepoFilterOptions}
              selectedIds={globalChartMultiRepoValue}
              onChange={(nextRepoIds) => {
                setGlobalChartScopeMode('multi')
                setGlobalChartMultiRepoIds(nextRepoIds)
              }}
              disabled={loadedRepoOptions.length === 0}
            />
          </label>
          <label>
            Users
            <MultiSelectFilterDropdown
              options={loadedUserFilterOptions}
              selectedIds={globalChartUserValue}
              onChange={setGlobalChartUserIds}
              disabled={loadedUserOptions.length === 0}
            />
          </label>
          <label>
            Start
            <input
              type="date"
              value={globalChartStartDay}
              min={lastRunRange?.startDay}
              max={lastRunRange?.endDay}
              onChange={(event) => setGlobalChartStartDay(event.target.value)}
              disabled={loadedRepoCount === 0 || !lastRunRange}
            />
          </label>
          <label>
            End
            <input
              type="date"
              value={globalChartEndDay}
              min={lastRunRange?.startDay}
              max={lastRunRange?.endDay}
              onChange={(event) => setGlobalChartEndDay(event.target.value)}
              disabled={loadedRepoCount === 0 || !lastRunRange}
            />
          </label>
          <label>
            Chart Style
            <select
              value={globalChartStyle}
              onChange={(event) => setGlobalChartStyle(event.target.value as ChartStyle)}
              disabled={loadedRepoCount === 0}
            >
              <option value="line">Line</option>
              <option value="bar">Bar</option>
              <option value="cumulative">Cumulative</option>
            </select>
          </label>
          <label>
            Breakdown
            <select
              value={globalChartBreakdownMode}
              onChange={(event) => setGlobalChartBreakdownMode(event.target.value as ChartBreakdownMode)}
              disabled={loadedRepoCount === 0}
            >
              <option value="aggregate">Total</option>
              <option value="byRepo">Per repo</option>
              <option value="byUser">Per user</option>
            </select>
          </label>
          <label>
            Cycle Smoothing
            <select
              value={globalCycleSmoothing}
              onChange={(event) => setGlobalCycleSmoothing(event.target.value as '2' | '4' | '8')}
              disabled={loadedRepoCount === 0}
            >
              <option value="2">2 buckets</option>
              <option value="4">4 buckets</option>
              <option value="8">8 buckets</option>
            </select>
          </label>
        </div>
        <p className={globalFiltersMessageClassName}>
          {globalFiltersMessage.length > 0
            ? globalFiltersMessage
            : 'Configure shared filters, then apply to sync all chart sections.'}
        </p>
      </section>

      <main className="dashboard">
        <section className="panel dashboard-section" key="Commits">
          <div className="dashboard-section-header">
            <h2>Commits</h2>
            <div className="chart-control-bar">
              <label>
                Granularity
                <select
                  value={commitsChartGranularity}
                  onChange={(event) => setCommitsChartGranularity(event.target.value as AggregationGranularity)}
                  disabled={loadedRepoCount === 0}
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              <label>
                Repositories
                <MultiSelectFilterDropdown
                  options={loadedRepoFilterOptions}
                  selectedIds={commitsChartMultiRepoValue}
                  onChange={(nextRepoIds) => {
                    setCommitsChartScopeMode('multi')
                    setCommitsChartMultiRepoIds(nextRepoIds)
                  }}
                  disabled={loadedRepoOptions.length === 0}
                />
              </label>
              <label>
                Users
                <MultiSelectFilterDropdown
                  options={loadedUserFilterOptions}
                  selectedIds={commitsChartUserValue}
                  onChange={setCommitsChartUserIds}
                  disabled={loadedUserOptions.length === 0}
                />
              </label>
              <label>
                Start
                <input
                  type="date"
                  value={commitsChartStartDay}
                  min={lastRunRange?.startDay}
                  max={lastRunRange?.endDay}
                  onChange={(event) => setCommitsChartStartDay(event.target.value)}
                  disabled={loadedRepoCount === 0 || !lastRunRange}
                />
              </label>
              <label>
                End
                <input
                  type="date"
                  value={commitsChartEndDay}
                  min={lastRunRange?.startDay}
                  max={lastRunRange?.endDay}
                  onChange={(event) => setCommitsChartEndDay(event.target.value)}
                  disabled={loadedRepoCount === 0 || !lastRunRange}
                />
              </label>
              <label>
                Chart Style
                <select
                  value={commitsChartStyle}
                  onChange={(event) => setCommitsChartStyle(event.target.value as ChartStyle)}
                  disabled={loadedRepoCount === 0}
                >
                  <option value="line">Line</option>
                  <option value="bar">Bar</option>
                  <option value="cumulative">Cumulative</option>
                </select>
              </label>
              <label>
                Breakdown
                <select
                  value={commitsChartBreakdownMode}
                  onChange={(event) => setCommitsChartBreakdownMode(event.target.value as ChartBreakdownMode)}
                  disabled={loadedRepoCount === 0}
                >
                  <option value="aggregate">Total</option>
                  <option value="byRepo">Per repo</option>
                  <option value="byUser">Per user</option>
                </select>
              </label>
            </div>
          </div>
          {!commitsChartRangeResolution.ok ? (
            <div className="chart-placeholder">{commitsChartRangeResolution.message}</div>
          ) : commitsChartAggregation ? (
            <>
              <div className="stats-grid">
                <div className="stat-card">
                  <p>Total Commits</p>
                  <strong>{commitsChartAggregation.totals.commits}</strong>
                </div>
                <div className="stat-card">
                  <p>Avg commits / {commitsUnit}</p>
                  <strong>{commitsPerTimeStats.average === null ? '-' : commitsPerTimeStats.average.toFixed(1)}</strong>
                </div>
                <div className="stat-card">
                  <p>Median commits / {commitsUnit}</p>
                  <strong>{commitsPerTimeStats.median === null ? '-' : commitsPerTimeStats.median.toFixed(1)}</strong>
                </div>
              </div>
              <ActivityLineChart
                data={commitsChartData}
                breakdownMode={commitsChartBreakdownMode}
                chartStyle={commitsChartStyle}
                lines={commitsChartLines}
                aggregateLabel="Total commits"
                emptyMessage="No commit buckets in this range."
              />
            </>
          ) : (
            <div className="chart-placeholder">No commit data for the selected chart range.</div>
          )}
        </section>

        <section className="panel dashboard-section" key="PRs Opened">
          <div className="dashboard-section-header">
            <h2>PRs Opened</h2>
            <div className="chart-control-bar">
              <label>
                Granularity
                <select
                  value={prChartGranularity}
                  onChange={(event) => setPrChartGranularity(event.target.value as AggregationGranularity)}
                  disabled={loadedRepoCount === 0}
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              <label>
                Repositories
                <MultiSelectFilterDropdown
                  options={loadedRepoFilterOptions}
                  selectedIds={prChartMultiRepoValue}
                  onChange={(nextRepoIds) => {
                    setPrChartScopeMode('multi')
                    setPrChartMultiRepoIds(nextRepoIds)
                  }}
                  disabled={loadedRepoOptions.length === 0}
                />
              </label>
              <label>
                Users
                <MultiSelectFilterDropdown
                  options={loadedUserFilterOptions}
                  selectedIds={prChartUserValue}
                  onChange={setPrChartUserIds}
                  disabled={loadedUserOptions.length === 0}
                />
              </label>
              <label>
                Start
                <input
                  type="date"
                  value={prChartStartDay}
                  min={lastRunRange?.startDay}
                  max={lastRunRange?.endDay}
                  onChange={(event) => setPrChartStartDay(event.target.value)}
                  disabled={loadedRepoCount === 0 || !lastRunRange}
                />
              </label>
              <label>
                End
                <input
                  type="date"
                  value={prChartEndDay}
                  min={lastRunRange?.startDay}
                  max={lastRunRange?.endDay}
                  onChange={(event) => setPrChartEndDay(event.target.value)}
                  disabled={loadedRepoCount === 0 || !lastRunRange}
                />
              </label>
              <label>
                Chart Style
                <select
                  value={prChartStyle}
                  onChange={(event) => setPrChartStyle(event.target.value as ChartStyle)}
                  disabled={loadedRepoCount === 0}
                >
                  <option value="line">Line</option>
                  <option value="bar">Bar</option>
                  <option value="cumulative">Cumulative</option>
                </select>
              </label>
              <label>
                Breakdown
                <select
                  value={prChartBreakdownMode}
                  onChange={(event) => setPrChartBreakdownMode(event.target.value as ChartBreakdownMode)}
                  disabled={loadedRepoCount === 0}
                >
                  <option value="aggregate">Total</option>
                  <option value="byRepo">Per repo</option>
                  <option value="byUser">Per user</option>
                </select>
              </label>
            </div>
          </div>
          {!prChartRangeResolution.ok ? (
            <div className="chart-placeholder">{prChartRangeResolution.message}</div>
          ) : prChartAggregation ? (
            <>
              <div className="stats-grid">
                <div className="stat-card">
                  <p>PRs Opened</p>
                  <strong>{prChartAggregation.totals.prsOpened}</strong>
                </div>
                <div className="stat-card">
                  <p>Avg PRs opened / {prUnit}</p>
                  <strong>{prOpenedPerTimeStats.average === null ? '-' : prOpenedPerTimeStats.average.toFixed(1)}</strong>
                </div>
                <div className="stat-card">
                  <p>Median PRs opened / {prUnit}</p>
                  <strong>{prOpenedPerTimeStats.median === null ? '-' : prOpenedPerTimeStats.median.toFixed(1)}</strong>
                </div>
              </div>
              <ActivityLineChart
                data={prOpenedChartData}
                breakdownMode={prChartBreakdownMode}
                chartStyle={prChartStyle}
                lines={prOpenedChartLines}
                aggregateLabel="Opened PRs"
                emptyMessage="No opened PR buckets in this range."
              />
            </>
          ) : (
            <div className="chart-placeholder">No opened PR data for the selected chart range.</div>
          )}
        </section>

        <section className="panel dashboard-section" key="PRs Merged">
          <div className="dashboard-section-header">
            <h2>PRs Merged</h2>
            <div className="chart-control-bar">
              <label>
                Granularity
                <select
                  value={prChartGranularity}
                  onChange={(event) => setPrChartGranularity(event.target.value as AggregationGranularity)}
                  disabled={loadedRepoCount === 0}
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              <label>
                Repositories
                <MultiSelectFilterDropdown
                  options={loadedRepoFilterOptions}
                  selectedIds={prChartMultiRepoValue}
                  onChange={(nextRepoIds) => {
                    setPrChartScopeMode('multi')
                    setPrChartMultiRepoIds(nextRepoIds)
                  }}
                  disabled={loadedRepoOptions.length === 0}
                />
              </label>
              <label>
                Users
                <MultiSelectFilterDropdown
                  options={loadedUserFilterOptions}
                  selectedIds={prChartUserValue}
                  onChange={setPrChartUserIds}
                  disabled={loadedUserOptions.length === 0}
                />
              </label>
              <label>
                Start
                <input
                  type="date"
                  value={prChartStartDay}
                  min={lastRunRange?.startDay}
                  max={lastRunRange?.endDay}
                  onChange={(event) => setPrChartStartDay(event.target.value)}
                  disabled={loadedRepoCount === 0 || !lastRunRange}
                />
              </label>
              <label>
                End
                <input
                  type="date"
                  value={prChartEndDay}
                  min={lastRunRange?.startDay}
                  max={lastRunRange?.endDay}
                  onChange={(event) => setPrChartEndDay(event.target.value)}
                  disabled={loadedRepoCount === 0 || !lastRunRange}
                />
              </label>
              <label>
                Chart Style
                <select
                  value={prChartStyle}
                  onChange={(event) => setPrChartStyle(event.target.value as ChartStyle)}
                  disabled={loadedRepoCount === 0}
                >
                  <option value="line">Line</option>
                  <option value="bar">Bar</option>
                  <option value="cumulative">Cumulative</option>
                </select>
              </label>
              <label>
                Breakdown
                <select
                  value={prChartBreakdownMode}
                  onChange={(event) => setPrChartBreakdownMode(event.target.value as ChartBreakdownMode)}
                  disabled={loadedRepoCount === 0}
                >
                  <option value="aggregate">Total</option>
                  <option value="byRepo">Per repo</option>
                  <option value="byUser">Per user</option>
                </select>
              </label>
            </div>
          </div>
          {!prChartRangeResolution.ok ? (
            <div className="chart-placeholder">{prChartRangeResolution.message}</div>
          ) : prChartAggregation ? (
            <>
              <div className="stats-grid">
                <div className="stat-card">
                  <p>PRs Merged</p>
                  <strong>{prChartAggregation.totals.prsMerged}</strong>
                </div>
                <div className="stat-card">
                  <p>Avg PRs merged / {prUnit}</p>
                  <strong>{prMergedPerTimeStats.average === null ? '-' : prMergedPerTimeStats.average.toFixed(1)}</strong>
                </div>
                <div className="stat-card">
                  <p>Median PRs merged / {prUnit}</p>
                  <strong>{prMergedPerTimeStats.median === null ? '-' : prMergedPerTimeStats.median.toFixed(1)}</strong>
                </div>
              </div>
              <ActivityLineChart
                data={prMergedChartData}
                breakdownMode={prChartBreakdownMode}
                chartStyle={prChartStyle}
                lines={prMergedChartLines}
                aggregateLabel="Merged PRs"
                emptyMessage="No merged PR buckets in this range."
              />
            </>
          ) : (
            <div className="chart-placeholder">No merged PR data for the selected chart range.</div>
          )}
        </section>

        <section className="panel dashboard-section" key="Issues Opened">
          <div className="dashboard-section-header">
            <h2>Issues Opened</h2>
            <div className="chart-control-bar">
              <label>
                Granularity
                <select
                  value={issuesOpenedChartGranularity}
                  onChange={(event) => setIssuesOpenedChartGranularity(event.target.value as AggregationGranularity)}
                  disabled={loadedRepoCount === 0}
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              <label>
                Repositories
                <MultiSelectFilterDropdown
                  options={loadedRepoFilterOptions}
                  selectedIds={issuesOpenedChartMultiRepoValue}
                  onChange={(nextRepoIds) => {
                    setIssuesOpenedChartScopeMode('multi')
                    setIssuesOpenedChartMultiRepoIds(nextRepoIds)
                  }}
                  disabled={loadedRepoOptions.length === 0}
                />
              </label>
              <label>
                Users
                <MultiSelectFilterDropdown
                  options={loadedUserFilterOptions}
                  selectedIds={issuesOpenedChartUserValue}
                  onChange={setIssuesOpenedChartUserIds}
                  disabled={loadedUserOptions.length === 0}
                />
              </label>
              <label>
                Start
                <input
                  type="date"
                  value={issuesOpenedChartStartDay}
                  min={lastRunRange?.startDay}
                  max={lastRunRange?.endDay}
                  onChange={(event) => setIssuesOpenedChartStartDay(event.target.value)}
                  disabled={loadedRepoCount === 0 || !lastRunRange}
                />
              </label>
              <label>
                End
                <input
                  type="date"
                  value={issuesOpenedChartEndDay}
                  min={lastRunRange?.startDay}
                  max={lastRunRange?.endDay}
                  onChange={(event) => setIssuesOpenedChartEndDay(event.target.value)}
                  disabled={loadedRepoCount === 0 || !lastRunRange}
                />
              </label>
              <label>
                Chart Style
                <select
                  value={issuesOpenedChartStyle}
                  onChange={(event) => setIssuesOpenedChartStyle(event.target.value as ChartStyle)}
                  disabled={loadedRepoCount === 0}
                >
                  <option value="line">Line</option>
                  <option value="bar">Bar</option>
                  <option value="cumulative">Cumulative</option>
                </select>
              </label>
              <label>
                Breakdown
                <select
                  value={issuesOpenedChartBreakdownMode}
                  onChange={(event) => setIssuesOpenedChartBreakdownMode(event.target.value as ChartBreakdownMode)}
                  disabled={loadedRepoCount === 0}
                >
                  <option value="aggregate">Total</option>
                  <option value="byRepo">Per repo</option>
                  <option value="byUser">Per user</option>
                </select>
              </label>
            </div>
          </div>
          {!issuesOpenedChartRangeResolution.ok ? (
            <div className="chart-placeholder">{issuesOpenedChartRangeResolution.message}</div>
          ) : issuesOpenedChartAggregation ? (
            <>
              <div className="stats-grid">
                <div className="stat-card">
                  <p>Issues Opened</p>
                  <strong>{issuesOpenedChartAggregation.totals.issuesOpened}</strong>
                </div>
                <div className="stat-card">
                  <p>Avg issues opened / {issuesOpenedUnit}</p>
                  <strong>
                    {issuesOpenedPerTimeStats.average === null ? '-' : issuesOpenedPerTimeStats.average.toFixed(1)}
                  </strong>
                </div>
                <div className="stat-card">
                  <p>Median issues opened / {issuesOpenedUnit}</p>
                  <strong>{issuesOpenedPerTimeStats.median === null ? '-' : issuesOpenedPerTimeStats.median.toFixed(1)}</strong>
                </div>
              </div>
              <ActivityLineChart
                data={issuesOpenedChartData}
                breakdownMode={issuesOpenedChartBreakdownMode}
                chartStyle={issuesOpenedChartStyle}
                lines={issuesOpenedChartLines}
                aggregateLabel="Issues opened"
                emptyMessage="No opened issue buckets in this range."
              />
            </>
          ) : (
            <div className="chart-placeholder">No opened issue data for the selected chart range.</div>
          )}
        </section>

        <section className="panel dashboard-section" key="Issues Closed">
          <div className="dashboard-section-header">
            <h2>Issues Closed</h2>
            <div className="chart-control-bar">
              <label>
                Granularity
                <select
                  value={issuesClosedChartGranularity}
                  onChange={(event) => setIssuesClosedChartGranularity(event.target.value as AggregationGranularity)}
                  disabled={loadedRepoCount === 0}
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              <label>
                Repositories
                <MultiSelectFilterDropdown
                  options={loadedRepoFilterOptions}
                  selectedIds={issuesClosedChartMultiRepoValue}
                  onChange={(nextRepoIds) => {
                    setIssuesClosedChartScopeMode('multi')
                    setIssuesClosedChartMultiRepoIds(nextRepoIds)
                  }}
                  disabled={loadedRepoOptions.length === 0}
                />
              </label>
              <label>
                Users
                <MultiSelectFilterDropdown
                  options={loadedUserFilterOptions}
                  selectedIds={issuesClosedChartUserValue}
                  onChange={setIssuesClosedChartUserIds}
                  disabled={loadedUserOptions.length === 0}
                />
              </label>
              <label>
                Start
                <input
                  type="date"
                  value={issuesClosedChartStartDay}
                  min={lastRunRange?.startDay}
                  max={lastRunRange?.endDay}
                  onChange={(event) => setIssuesClosedChartStartDay(event.target.value)}
                  disabled={loadedRepoCount === 0 || !lastRunRange}
                />
              </label>
              <label>
                End
                <input
                  type="date"
                  value={issuesClosedChartEndDay}
                  min={lastRunRange?.startDay}
                  max={lastRunRange?.endDay}
                  onChange={(event) => setIssuesClosedChartEndDay(event.target.value)}
                  disabled={loadedRepoCount === 0 || !lastRunRange}
                />
              </label>
              <label>
                Chart Style
                <select
                  value={issuesClosedChartStyle}
                  onChange={(event) => setIssuesClosedChartStyle(event.target.value as ChartStyle)}
                  disabled={loadedRepoCount === 0}
                >
                  <option value="line">Line</option>
                  <option value="bar">Bar</option>
                  <option value="cumulative">Cumulative</option>
                </select>
              </label>
              <label>
                Breakdown
                <select
                  value={issuesClosedChartBreakdownMode}
                  onChange={(event) => setIssuesClosedChartBreakdownMode(event.target.value as ChartBreakdownMode)}
                  disabled={loadedRepoCount === 0}
                >
                  <option value="aggregate">Total</option>
                  <option value="byRepo">Per repo</option>
                  <option value="byUser">Per user</option>
                </select>
              </label>
            </div>
          </div>
          {!issuesClosedChartRangeResolution.ok ? (
            <div className="chart-placeholder">{issuesClosedChartRangeResolution.message}</div>
          ) : issuesClosedChartAggregation ? (
            <>
              <div className="stats-grid">
                <div className="stat-card">
                  <p>Issues Closed</p>
                  <strong>{issuesClosedChartAggregation.totals.issuesClosed}</strong>
                </div>
                <div className="stat-card">
                  <p>Avg issues closed / {issuesClosedUnit}</p>
                  <strong>
                    {issuesClosedPerTimeStats.average === null ? '-' : issuesClosedPerTimeStats.average.toFixed(1)}
                  </strong>
                </div>
                <div className="stat-card">
                  <p>Median issues closed / {issuesClosedUnit}</p>
                  <strong>{issuesClosedPerTimeStats.median === null ? '-' : issuesClosedPerTimeStats.median.toFixed(1)}</strong>
                </div>
              </div>
              <ActivityLineChart
                data={issuesClosedChartData}
                breakdownMode={issuesClosedChartBreakdownMode}
                chartStyle={issuesClosedChartStyle}
                lines={issuesClosedChartLines}
                aggregateLabel="Issues closed"
                emptyMessage="No closed issue buckets in this range."
              />
            </>
          ) : (
            <div className="chart-placeholder">No closed issue data for the selected chart range.</div>
          )}
        </section>

        <section className="panel dashboard-section" key="Cycle Time">
          <div className="dashboard-section-header">
            <h2>Cycle Time</h2>
            <div className="chart-control-bar">
              <label>
                Granularity
                <select
                  value={cycleChartGranularity}
                  onChange={(event) => setCycleChartGranularity(event.target.value as AggregationGranularity)}
                  disabled={loadedRepoCount === 0}
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              <label>
                Repositories
                <MultiSelectFilterDropdown
                  options={loadedRepoFilterOptions}
                  selectedIds={cycleChartMultiRepoValue}
                  onChange={(nextRepoIds) => {
                    setCycleChartScopeMode('multi')
                    setCycleChartMultiRepoIds(nextRepoIds)
                  }}
                  disabled={loadedRepoOptions.length === 0}
                />
              </label>
              <label>
                Users
                <MultiSelectFilterDropdown
                  options={loadedUserFilterOptions}
                  selectedIds={cycleChartUserValue}
                  onChange={setCycleChartUserIds}
                  disabled={loadedUserOptions.length === 0}
                />
              </label>
              <label>
                Start
                <input
                  type="date"
                  value={cycleChartStartDay}
                  min={lastRunRange?.startDay}
                  max={lastRunRange?.endDay}
                  onChange={(event) => setCycleChartStartDay(event.target.value)}
                  disabled={loadedRepoCount === 0 || !lastRunRange}
                />
              </label>
              <label>
                End
                <input
                  type="date"
                  value={cycleChartEndDay}
                  min={lastRunRange?.startDay}
                  max={lastRunRange?.endDay}
                  onChange={(event) => setCycleChartEndDay(event.target.value)}
                  disabled={loadedRepoCount === 0 || !lastRunRange}
                />
              </label>
              <label>
                Smoothing
                <select
                  value={cycleRollingWindow}
                  onChange={(event) => setCycleRollingWindow(event.target.value as '2' | '4' | '8')}
                  disabled={loadedRepoCount === 0}
                >
                  <option value="2">2 buckets</option>
                  <option value="4">4 buckets</option>
                  <option value="8">8 buckets</option>
                </select>
              </label>
            </div>
          </div>
          {!cycleChartRangeResolution.ok ? (
            <div className="chart-placeholder">{cycleChartRangeResolution.message}</div>
          ) : cycleChartAggregation ? (
            <>
              <div className="stats-grid">
                <div className="stat-card">
                  <p>Merge Avg (days)</p>
                  <strong>
                    {cycleChartAggregation.mergeTime.averageDays === null
                      ? '-'
                      : cycleChartAggregation.mergeTime.averageDays.toFixed(1)}
                  </strong>
                </div>
                <div className="stat-card">
                  <p>Merge Median (days)</p>
                  <strong>
                    {cycleChartAggregation.mergeTime.medianDays === null
                      ? '-'
                      : cycleChartAggregation.mergeTime.medianDays.toFixed(1)}
                  </strong>
                </div>
                <div className="stat-card">
                  <p>Merge Samples</p>
                  <strong>{cycleChartAggregation.mergeTime.count}</strong>
                </div>
                <div className="stat-card">
                  <p>Avg merged PRs / {cycleUnit}</p>
                  <strong>{cyclePerTimeStats.average === null ? '-' : cyclePerTimeStats.average.toFixed(1)}</strong>
                </div>
                <div className="stat-card">
                  <p>Median merged PRs / {cycleUnit}</p>
                  <strong>{cyclePerTimeStats.median === null ? '-' : cyclePerTimeStats.median.toFixed(1)}</strong>
                </div>
              </div>
              <div className="pr-trend-card">
                <h3>Merge Turnaround Trend (days)</h3>
                {cycleMergeTimeTrendData.length === 0 ? (
                  <p className="commits-chart-empty">No merge-time trend points in this range.</p>
                ) : (
                  <div className="commits-chart-canvas">
                    <ResponsiveContainer width="100%" height={450}>
                      <LineChart data={cycleMergeTimeTrendData} margin={{ top: 10, right: 24, left: 10, bottom: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} />
                        <XAxis dataKey="bucketLabel" minTickGap={28} tick={{ fill: CHART_AXIS_COLOR, fontSize: 12 }} />
                        <YAxis tick={{ fill: CHART_AXIS_COLOR, fontSize: 12 }} />
                        <Tooltip
                          contentStyle={{ borderRadius: 8, border: `1px solid ${CHART_TOOLTIP_BORDER}` }}
                          labelStyle={{ color: CHART_TOOLTIP_LABEL, fontWeight: 700 }}
                        />
                        <Legend />
                        <Line
                          type="monotone"
                          dataKey="averageDays"
                          name="Bucket average (days)"
                          stroke={CHART_TURNAROUND_BUCKET_COLOR}
                          strokeWidth={1.5}
                          dot={false}
                          activeDot={{ r: 4 }}
                          connectNulls
                        />
                        <Line
                          type="monotone"
                          dataKey="rollingAverageDays"
                          name={`Rolling avg (${cycleRollingWindowSize} buckets, days)`}
                          stroke={CHART_TURNAROUND_ROLLING_COLOR}
                          strokeWidth={2.5}
                          dot={false}
                          activeDot={{ r: 4 }}
                          connectNulls
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="chart-placeholder">No cycle-time data for the selected chart range.</div>
          )}
        </section>
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
