import { useEffect, useMemo, useRef, useState } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { GITHUB_GRAPHQL_ENDPOINT, GITHUB_REST_ENDPOINT } from './config/env'
import './App.css'

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
const CHART_COLORS = ['#1f7a3a', '#2f8f57', '#1f5d8b', '#8b651b', '#9a3f2f', '#5f4ca1', '#0e7490', '#6b8e23']
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
  mergedAt: string
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
  issuesOpened: IssueRecord[]
  issuesClosed: IssueRecord[]
  commits: CommitRecord[]
}

type RepoRawAnalysisData = {
  repoId: string
  repoName: string
  defaultBranch?: string
  pullRequests: RawPullRequestRecord[]
  issuesOpened: RawIssueRecord[]
  issuesClosed: RawIssueRecord[]
  commits: RawCommitRecord[]
}

type AggregationGranularity = 'daily' | 'weekly' | 'monthly'
type AggregationScope = 'selected' | 'loaded'
type CommitsChartScopeMode = 'all' | 'multi' | 'single'
type CommitsChartSeriesMode = 'aggregate' | 'byRepo'

type AggregatedBucketPoint = {
  bucketStart: string
  bucketLabel: string
  total: number
  byRepo: Record<string, number>
}

type AggregatedRepoTotals = {
  repoId: string
  repoName: string
  commits: number
  prsMerged: number
  issuesOpened: number
  issuesClosed: number
  mergeTimeCount: number
  mergeTimeAverageHours: number | null
  mergeTimeMedianHours: number | null
}

type AggregatedActivity = {
  range: RunDateRange
  granularity: AggregationGranularity
  repoIds: string[]
  totals: {
    commits: number
    prsMerged: number
    issuesOpened: number
    issuesClosed: number
  }
  mergeTime: {
    count: number
    averageHours: number | null
    medianHours: number | null
  }
  series: {
    commits: AggregatedBucketPoint[]
    prsMerged: AggregatedBucketPoint[]
    issuesOpened: AggregatedBucketPoint[]
    issuesClosed: AggregatedBucketPoint[]
  }
  perRepoTotals: AggregatedRepoTotals[]
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

function normalizePullRequestRecords(rawRecords: RawPullRequestRecord[]): PullRequestRecord[] {
  const normalized: PullRequestRecord[] = []
  const seenIds = new Set<string>()

  for (const raw of rawRecords) {
    const id = normalizeText(raw.id)
    const title = normalizeText(raw.title)
    const url = normalizeText(raw.url)
    const createdAt = normalizeIsoTimestamp(raw.createdAt)
    const mergedAt = normalizeIsoTimestamp(raw.mergedAt)
    if (
      !id ||
      seenIds.has(id) ||
      raw.number === undefined ||
      !title ||
      !url ||
      !createdAt ||
      !mergedAt
    ) {
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
    pullRequests: normalizePullRequestRecords(raw.pullRequests),
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
    const dayOffsetFromMonday = (bucketDate.getUTCDay() + 6) % 7
    bucketDate.setUTCDate(bucketDate.getUTCDate() - dayOffsetFromMonday)
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

function aggregateRepositoryActivity(
  analysisByRepo: Record<string, RepoAnalysisData>,
  repoIds: string[],
  range: RunDateRange,
  granularity: AggregationGranularity,
): AggregatedActivity {
  const bucketTimeline = createBucketTimeline(range, granularity)
  const bucketPointMap = {
    commits: new Map<string, AggregatedBucketPoint>(),
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
    }
    bucketPointMap.commits.set(bucketStart, { ...pointBase, byRepo: {} })
    bucketPointMap.prsMerged.set(bucketStart, { ...pointBase, byRepo: {} })
    bucketPointMap.issuesOpened.set(bucketStart, { ...pointBase, byRepo: {} })
    bucketPointMap.issuesClosed.set(bucketStart, { ...pointBase, byRepo: {} })
  }

  const rangeStartTime = new Date(range.startIso).valueOf()
  const rangeEndTime = new Date(range.endIso).valueOf()
  const globalMergeDurations: number[] = []
  const perRepoTotals: AggregatedRepoTotals[] = []

  function addToBucket(
    bucketMap: Map<string, AggregatedBucketPoint>,
    bucketIso: string,
    repoId: string,
    incrementBy: number,
  ) {
    const bucketPoint = bucketMap.get(bucketIso)
    if (!bucketPoint) {
      return
    }

    bucketPoint.total += incrementBy
    bucketPoint.byRepo[repoId] = (bucketPoint.byRepo[repoId] ?? 0) + incrementBy
  }

  for (const repoId of repoIds) {
    const repoData = analysisByRepo[repoId]
    if (!repoData) {
      continue
    }

    let repoCommits = 0
    let repoPrsMerged = 0
    let repoIssuesOpened = 0
    let repoIssuesClosed = 0
    const repoMergeDurations: number[] = []

    for (const commit of repoData.commits) {
      const commitTime = new Date(commit.authoredDate).valueOf()
      if (Number.isNaN(commitTime) || commitTime < rangeStartTime || commitTime > rangeEndTime) {
        continue
      }

      const bucketStartDate = getBucketStartDate(commit.authoredDate, granularity)
      if (!bucketStartDate) {
        continue
      }

      addToBucket(bucketPointMap.commits, bucketStartDate.toISOString(), repoId, 1)
      repoCommits += 1
    }

    for (const pullRequest of repoData.pullRequests) {
      const mergedTime = new Date(pullRequest.mergedAt).valueOf()
      if (Number.isNaN(mergedTime) || mergedTime < rangeStartTime || mergedTime > rangeEndTime) {
        continue
      }

      const bucketStartDate = getBucketStartDate(pullRequest.mergedAt, granularity)
      if (!bucketStartDate) {
        continue
      }

      addToBucket(bucketPointMap.prsMerged, bucketStartDate.toISOString(), repoId, 1)
      repoPrsMerged += 1

      const createdTime = new Date(pullRequest.createdAt).valueOf()
      if (!Number.isNaN(createdTime) && mergedTime > createdTime) {
        const durationHours = (mergedTime - createdTime) / (1000 * 60 * 60)
        repoMergeDurations.push(durationHours)
        globalMergeDurations.push(durationHours)
      }
    }

    for (const openedIssue of repoData.issuesOpened) {
      const openedTime = new Date(openedIssue.createdAt).valueOf()
      if (Number.isNaN(openedTime) || openedTime < rangeStartTime || openedTime > rangeEndTime) {
        continue
      }

      const bucketStartDate = getBucketStartDate(openedIssue.createdAt, granularity)
      if (!bucketStartDate) {
        continue
      }

      addToBucket(bucketPointMap.issuesOpened, bucketStartDate.toISOString(), repoId, 1)
      repoIssuesOpened += 1
    }

    for (const closedIssue of repoData.issuesClosed) {
      if (!closedIssue.closedAt) {
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

      addToBucket(bucketPointMap.issuesClosed, bucketStartDate.toISOString(), repoId, 1)
      repoIssuesClosed += 1
    }

    perRepoTotals.push({
      repoId,
      repoName: repoData.repoName,
      commits: repoCommits,
      prsMerged: repoPrsMerged,
      issuesOpened: repoIssuesOpened,
      issuesClosed: repoIssuesClosed,
      mergeTimeCount: repoMergeDurations.length,
      mergeTimeAverageHours: calculateAverage(repoMergeDurations),
      mergeTimeMedianHours: calculateMedian(repoMergeDurations),
    })
  }

  perRepoTotals.sort((left, right) => left.repoName.localeCompare(right.repoName))

  const commitsSeries = bucketTimeline
    .map((bucketStart) => bucketPointMap.commits.get(bucketStart))
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
      prsMerged: prsMergedSeries.reduce((accumulator, point) => accumulator + point.total, 0),
      issuesOpened: issuesOpenedSeries.reduce((accumulator, point) => accumulator + point.total, 0),
      issuesClosed: issuesClosedSeries.reduce((accumulator, point) => accumulator + point.total, 0),
    },
    mergeTime: {
      count: globalMergeDurations.length,
      averageHours: calculateAverage(globalMergeDurations),
      medianHours: calculateMedian(globalMergeDurations),
    },
    series: {
      commits: commitsSeries,
      prsMerged: prsMergedSeries,
      issuesOpened: issuesOpenedSeries,
      issuesClosed: issuesClosedSeries,
    },
    perRepoTotals,
  }
}

type CommitsChartLine = {
  dataKey: string
  label: string
  color: string
}

type CommitsChartDatum = {
  bucketStart: string
  bucketLabel: string
  total: number
  [repoSeriesKey: string]: number | string
}

function CommitsLineChart({
  data,
  seriesMode,
  lines,
}: {
  data: CommitsChartDatum[]
  seriesMode: CommitsChartSeriesMode
  lines: CommitsChartLine[]
}) {
  if (data.length === 0) {
    return <p className="commits-chart-empty">No commit buckets in this range.</p>
  }

  const hasPerRepoLines = lines.length > 0
  if (seriesMode === 'byRepo' && !hasPerRepoLines) {
    return <p className="commits-chart-empty">No repositories available for per-repo commit series.</p>
  }

  return (
    <div className="commits-chart-canvas">
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={data} margin={{ top: 10, right: 24, left: 10, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#d8e2ce" />
          <XAxis dataKey="bucketLabel" minTickGap={28} tick={{ fill: '#47603a', fontSize: 12 }} />
          <YAxis allowDecimals={false} tick={{ fill: '#47603a', fontSize: 12 }} />
          <Tooltip
            contentStyle={{ borderRadius: 8, border: '1px solid #d8e2ce' }}
            labelStyle={{ color: '#16210e', fontWeight: 700 }}
          />
          <Legend />
          {seriesMode === 'aggregate' ? (
            <Line
              type="monotone"
              dataKey="total"
              name="Total commits"
              stroke="#1f7a3a"
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
      </ResponsiveContainer>
    </div>
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
  const [activeStep, setActiveStep] = useState<RunStepKey | null>(null)
  const [stepStatuses, setStepStatuses] = useState<StepStatusMap>(() => createStepStatusMap('queued'))
  const [repoMatrixRows, setRepoMatrixRows] = useState<RepoMatrixRow[]>([])
  const [runErrors, setRunErrors] = useState<RunErrorItem[]>([])
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null)
  const [runFinishedAt, setRunFinishedAt] = useState<number | null>(null)
  const [lastRunRange, setLastRunRange] = useState<RunDateRange | null>(null)
  const [lastRunRangeLabel, setLastRunRangeLabel] = useState<string>('Last 365 days')
  const [aggregationGranularity, setAggregationGranularity] = useState<AggregationGranularity>('weekly')
  const [aggregationScope, setAggregationScope] = useState<AggregationScope>('selected')
  const [commitsChartGranularity, setCommitsChartGranularity] = useState<AggregationGranularity>('weekly')
  const [commitsChartScopeMode, setCommitsChartScopeMode] = useState<CommitsChartScopeMode>('all')
  const [commitsChartSeriesMode, setCommitsChartSeriesMode] = useState<CommitsChartSeriesMode>('aggregate')
  const [commitsChartSingleRepoId, setCommitsChartSingleRepoId] = useState('')
  const [commitsChartMultiRepoIds, setCommitsChartMultiRepoIds] = useState<string[]>([])
  const [rateLimitSnapshot, setRateLimitSnapshot] = useState<RateLimitSnapshot | null>(null)
  const [analysisDataByRepo, setAnalysisDataByRepo] = useState<Record<string, RepoAnalysisData>>({})
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
        range: {
          startIso: startDate.toISOString(),
          endIso: endDate.toISOString(),
          startDay: customRangeStart,
          endDay: customRangeEnd,
          label: `${customRangeStart} to ${customRangeEnd}`,
        },
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
      range: {
        startIso: startDate.toISOString(),
        endIso: endDate.toISOString(),
        startDay: startDate.toISOString().slice(0, 10),
        endDay: endDate.toISOString().slice(0, 10),
        label: `Last ${days} days`,
      },
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
    setCommitsChartScopeMode('all')
    setCommitsChartSeriesMode('aggregate')
    setCommitsChartSingleRepoId('')
    setCommitsChartMultiRepoIds([])
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
                repoName: repoData.repoName,
              }
            : null
        })
        .filter((repoOption): repoOption is { repoId: string; repoName: string } => repoOption !== null)
        .sort((left, right) => left.repoName.localeCompare(right.repoName)),
    [analysisDataByRepo, loadedRepoIds],
  )
  const aggregationRepoIds = useMemo(() => {
    if (aggregationScope === 'loaded') {
      return loadedRepoIds
    }

    const selectedLoaded = selectedRepoIds.filter((repoId) => analysisDataByRepo[repoId] !== undefined)
    if (selectedLoaded.length > 0) {
      return selectedLoaded
    }

    return loadedRepoIds
  }, [aggregationScope, loadedRepoIds, selectedRepoIds, analysisDataByRepo])
  const aggregatedActivity = useMemo(() => {
    if (!lastRunRange || aggregationRepoIds.length === 0) {
      return null
    }

    return aggregateRepositoryActivity(analysisDataByRepo, aggregationRepoIds, lastRunRange, aggregationGranularity)
  }, [analysisDataByRepo, aggregationGranularity, aggregationRepoIds, lastRunRange])
  const commitsChartRepoIds = useMemo(() => {
    const effectiveSingleRepoId =
      commitsChartSingleRepoId.length > 0 && analysisDataByRepo[commitsChartSingleRepoId]
        ? commitsChartSingleRepoId
        : loadedRepoIds[0]
    const effectiveMultiRepoIds = commitsChartMultiRepoIds.filter((repoId) => analysisDataByRepo[repoId] !== undefined)

    if (commitsChartScopeMode === 'single') {
      if (effectiveSingleRepoId) {
        return [effectiveSingleRepoId]
      }

      return []
    }

    if (commitsChartScopeMode === 'multi') {
      return effectiveMultiRepoIds.length > 0 ? effectiveMultiRepoIds : loadedRepoIds
    }

    return loadedRepoIds
  }, [
    analysisDataByRepo,
    commitsChartMultiRepoIds,
    commitsChartScopeMode,
    commitsChartSingleRepoId,
    loadedRepoIds,
  ])
  const commitsChartAggregation = useMemo(() => {
    if (!lastRunRange || commitsChartRepoIds.length === 0) {
      return null
    }

    return aggregateRepositoryActivity(analysisDataByRepo, commitsChartRepoIds, lastRunRange, commitsChartGranularity)
  }, [analysisDataByRepo, commitsChartGranularity, commitsChartRepoIds, lastRunRange])
  const commitsChartData = useMemo(() => {
    if (!commitsChartAggregation) {
      return [] as CommitsChartDatum[]
    }

    return commitsChartAggregation.series.commits.map((point) => {
      const chartPoint: CommitsChartDatum = {
        bucketStart: point.bucketStart,
        bucketLabel: point.bucketLabel,
        total: point.total,
      }

      for (const repoId of commitsChartAggregation.repoIds) {
        const key = `repo:${repoId}`
        chartPoint[key] = point.byRepo[repoId] ?? 0
      }

      return chartPoint
    })
  }, [commitsChartAggregation])
  const commitsChartLines = useMemo(() => {
    if (!commitsChartAggregation) {
      return [] as CommitsChartLine[]
    }

    return commitsChartAggregation.repoIds.map((repoId, index) => ({
      dataKey: `repo:${repoId}`,
      label: analysisDataByRepo[repoId]?.repoName ?? repoId,
      color: CHART_COLORS[index % CHART_COLORS.length],
    }))
  }, [analysisDataByRepo, commitsChartAggregation])
  const commitsChartSingleRepoValue =
    commitsChartSingleRepoId.length > 0 && analysisDataByRepo[commitsChartSingleRepoId]
      ? commitsChartSingleRepoId
      : loadedRepoIds[0] ?? ''
  const commitsChartMultiRepoValue = commitsChartMultiRepoIds.filter(
    (repoId) => analysisDataByRepo[repoId] !== undefined,
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

  async function fetchMergedPullRequestsForRepo(
    trimmedToken: string,
    repoNameWithOwner: string,
    range: RunDateRange,
  ): Promise<RawPullRequestRecord[]> {
    const pullRequests: RawPullRequestRecord[] = []
    let cursor: string | null = null
    let hasNextPage = true
    const searchQuery = `repo:${repoNameWithOwner} is:pr is:merged merged:${range.startDay}..${range.endDay} sort:updated-desc`

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
        const pullRequests = await fetchMergedPullRequestsForRepo(trimmedToken, repository.nameWithOwner, runRange)
        if (!isRunActive(runId)) {
          return
        }

        nextRawAnalysisByRepo[repository.id].pullRequests = pullRequests
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
                  setLastRunRange(null)
                  setLastRunRangeLabel('Last 365 days')
                  setCommitsChartGranularity('weekly')
                  setCommitsChartScopeMode('all')
                  setCommitsChartSeriesMode('aggregate')
                  setCommitsChartSingleRepoId('')
                  setCommitsChartMultiRepoIds([])
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
          <p>Active Step: {activeStep ? RUN_STEPS.find((step) => step.key === activeStep)?.label : 'None'}</p>
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

        <div className="aggregation-preview-panel">
          <div className="aggregation-preview-header">
            <h3>Aggregation Preview</h3>
            <div className="aggregation-controls">
              <label>
                Granularity
                <select
                  value={aggregationGranularity}
                  onChange={(event) => setAggregationGranularity(event.target.value as AggregationGranularity)}
                  disabled={loadedRepoCount === 0}
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              <label>
                Repo Scope
                <select
                  value={aggregationScope}
                  onChange={(event) => setAggregationScope(event.target.value as AggregationScope)}
                  disabled={loadedRepoCount === 0}
                >
                  <option value="selected">Selected repos</option>
                  <option value="loaded">All loaded repos</option>
                </select>
              </label>
            </div>
          </div>
          {aggregatedActivity ? (
            <>
              <div className="aggregation-summary-grid">
                <p>Scope repos: {aggregatedActivity.repoIds.length}</p>
                <p>Commits: {aggregatedActivity.totals.commits}</p>
                <p>PRs merged: {aggregatedActivity.totals.prsMerged}</p>
                <p>Issues opened: {aggregatedActivity.totals.issuesOpened}</p>
                <p>Issues closed: {aggregatedActivity.totals.issuesClosed}</p>
                <p>
                  Merge time avg/median:{' '}
                  {aggregatedActivity.mergeTime.averageHours === null
                    ? '-'
                    : `${aggregatedActivity.mergeTime.averageHours.toFixed(1)}h`}
                  {' / '}
                  {aggregatedActivity.mergeTime.medianHours === null
                    ? '-'
                    : `${aggregatedActivity.mergeTime.medianHours.toFixed(1)}h`}
                </p>
              </div>
              <div className="aggregation-bucket-preview">
                <h4>Recent Buckets (Commits / PRs / Issues Opened / Issues Closed)</h4>
                {aggregatedActivity.series.commits.length === 0 ? (
                  <p>No buckets in selected range.</p>
                ) : (
                  <ul>
                    {aggregatedActivity.series.commits.slice(-5).map((commitPoint) => {
                      const prPoint = aggregatedActivity.series.prsMerged.find(
                        (seriesPoint) => seriesPoint.bucketStart === commitPoint.bucketStart,
                      )
                      const openedPoint = aggregatedActivity.series.issuesOpened.find(
                        (seriesPoint) => seriesPoint.bucketStart === commitPoint.bucketStart,
                      )
                      const closedPoint = aggregatedActivity.series.issuesClosed.find(
                        (seriesPoint) => seriesPoint.bucketStart === commitPoint.bucketStart,
                      )

                      return (
                        <li key={commitPoint.bucketStart}>
                          {commitPoint.bucketLabel}: {commitPoint.total} / {prPoint?.total ?? 0} /{' '}
                          {openedPoint?.total ?? 0} / {closedPoint?.total ?? 0}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </>
          ) : (
            <p className="aggregation-empty">Run analysis successfully to generate aggregated series.</p>
          )}
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
                Scope
                <select
                  value={commitsChartScopeMode}
                  onChange={(event) => setCommitsChartScopeMode(event.target.value as CommitsChartScopeMode)}
                  disabled={loadedRepoCount === 0}
                >
                  <option value="all">All loaded repos</option>
                  <option value="multi">Multi-select repos</option>
                  <option value="single">Single repo</option>
                </select>
              </label>
              <label>
                Series
                <select
                  value={commitsChartSeriesMode}
                  onChange={(event) => setCommitsChartSeriesMode(event.target.value as CommitsChartSeriesMode)}
                  disabled={loadedRepoCount === 0}
                >
                  <option value="aggregate">Aggregate line</option>
                  <option value="byRepo">Per-repo lines</option>
                </select>
              </label>
              {commitsChartScopeMode === 'single' && (
                <label>
                  Repo
                  <select
                    value={commitsChartSingleRepoValue}
                    onChange={(event) => setCommitsChartSingleRepoId(event.target.value)}
                    disabled={loadedRepoOptions.length === 0}
                  >
                    {loadedRepoOptions.map((repoOption) => (
                      <option key={repoOption.repoId} value={repoOption.repoId}>
                        {repoOption.repoName}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {commitsChartScopeMode === 'multi' && (
                <label>
                  Repo Set
                  <select
                    multiple
                    size={Math.min(Math.max(loadedRepoOptions.length, 2), 6)}
                    value={commitsChartMultiRepoValue}
                    onChange={(event) => {
                      const selectedValues = Array.from(event.target.selectedOptions).map((option) => option.value)
                      setCommitsChartMultiRepoIds(selectedValues)
                    }}
                    disabled={loadedRepoOptions.length === 0}
                  >
                    {loadedRepoOptions.map((repoOption) => (
                      <option key={repoOption.repoId} value={repoOption.repoId}>
                        {repoOption.repoName}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </div>
          {commitsChartAggregation ? (
            <>
              <div className="stats-grid">
                <div className="stat-card">
                  <p>Total Commits</p>
                  <strong>{commitsChartAggregation.totals.commits}</strong>
                </div>
                <div className="stat-card">
                  <p>Repo Scope</p>
                  <strong>{commitsChartAggregation.repoIds.length}</strong>
                </div>
                <div className="stat-card">
                  <p>Bucket Count</p>
                  <strong>{commitsChartAggregation.series.commits.length}</strong>
                </div>
              </div>
              <CommitsLineChart
                data={commitsChartData}
                seriesMode={commitsChartSeriesMode}
                lines={commitsChartLines}
              />
            </>
          ) : (
            <div className="chart-placeholder">Run analysis to generate commit charts.</div>
          )}
        </section>

        {['Pull Requests', 'Issues', 'Cycle Time'].map((section) => (
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
