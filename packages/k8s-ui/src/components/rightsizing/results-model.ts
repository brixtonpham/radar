import type { DatadogSizingWorkload, RightsizingRow } from '../../types/rightsizing'
import { datadogRowReview, isDatadogRequestActionable } from '../../utils/rightsizing-reasons'

export type ScanClass = 'increase' | 'reduction' | 'review' | 'in_range' | 'need_data'

export interface RightsizingImpact {
  replicas: number
  cpuChange: number
  memoryChange: number
}

interface ScanWorkload {
  kind: string
  namespace: string
  name: string
  replicas: number
  scaledToZero: boolean
  rows: RightsizingRow[]
}

export interface RightsizingResultRow extends Omit<ScanWorkload, 'rows'> {
  id: string
  container: string
  clusterId?: string
  clusterName?: string
  source?: 'datadog' | 'prometheus'
  observedAt?: string
  cpu?: RightsizingRow
  memory?: RightsizingRow
  classification: ScanClass
  impact: RightsizingImpact
  workloadReason?: string
  workloadImpact?: Pick<RightsizingImpact, 'cpuChange' | 'memoryChange'>
  review?: Partial<Record<RightsizingRow['resource'], string>>
}

const CLASS_RANK: Record<ScanClass, number> = {
  increase: 1,
  reduction: 2,
  review: 3,
  need_data: 4,
  in_range: 5,
}

const MIN_CPU_REDUCTION = 0.05
const MIN_MEMORY_REDUCTION = 64 * 1024 * 1024

export function classifyRows(rows: RightsizingRow[], replicas = 1, scaledToZero = false): ScanClass {
  const evidenced = rows.filter((row) => !row.queryError && row.fit !== 'insufficient_history')
  if (evidenced.length === 0) return 'need_data'
  if (scaledToZero) return 'review'
  if (
    evidenced.some(
      (row) => (row.fit === 'under_requested' || row.fit === 'missing_request') && row.recommendedRequest,
    )
  )
    return 'increase'
  if (evidenced.some(needsManualReview)) return 'review'
  const impact = calculateImpact(evidenced, replicas)
  if (-impact.cpuChange >= MIN_CPU_REDUCTION || -impact.memoryChange >= MIN_MEMORY_REDUCTION)
    return 'reduction'
  return evidenced.length === rows.length ? 'in_range' : 'need_data'
}

function needsManualReview(row: RightsizingRow): boolean {
  return (
    row.hpaManaged ||
    needsSafetyReview(row) ||
    (isReduction(row) && row.bursty === true) ||
    row.recommendationReason === 'hpa_evidence_unavailable' ||
    row.recommendationReason === 'oom_evidence_unavailable' ||
    // Mirrors ManualReviewReasons: Radar does not size a pod-level request.
    row.fit === 'pod_level_request'
  )
}

function needsSafetyReview(row: RightsizingRow): boolean {
  return (
    row.currentPodOOM === true ||
    row.windowOomEvidence === true ||
    row.limitConflict === true ||
    (isReduction(row) && (row.throttleRatio ?? 0) >= 0.1)
  )
}

function scanPriority(row: RightsizingResultRow): number {
  if (
    !row.scaledToZero &&
    [row.cpu, row.memory].some(
      (resource) =>
        resource &&
        !resource.queryError &&
        resource.fit !== 'insufficient_history' &&
        needsSafetyReview(resource),
    )
  )
    return 0
  return CLASS_RANK[row.classification]
}

function isReduction(row: RightsizingRow): boolean {
  return (
    row.recommendedRequestValue != null &&
    row.currentRequestValue != null &&
    row.recommendedRequestValue < row.currentRequestValue
  )
}

export function calculateImpact(
  rows: RightsizingRow[],
  replicas: number,
  actionable: (row: RightsizingRow) => boolean = (row) => !needsManualReview(row),
): RightsizingImpact {
  const count = Math.max(replicas, 0)
  let cpuChange = 0
  let memoryChange = 0
  for (const row of rows) {
    if (row.recommendedRequestValue == null || !actionable(row)) continue
    const change = (row.recommendedRequestValue - (row.currentRequestValue ?? 0)) * count
    if (row.resource === 'cpu') cpuChange += change
    else memoryChange += change
  }
  return { replicas: count, cpuChange, memoryChange }
}

export function groupRightsizingRows(measurements: RightsizingRow[]): Map<string, RightsizingRow[]> {
  const byContainer = new Map<string, RightsizingRow[]>()
  for (const row of measurements) {
    const rows = byContainer.get(row.container) ?? []
    rows.push(row)
    byContainer.set(row.container, rows)
  }
  return byContainer
}

interface Cluster {
  id: string
  name: string
  observedAt?: string
}

export function workloadResultRows(
  workload: DatadogSizingWorkload | ScanWorkload,
  cluster: Cluster,
  workloadImpact?: RightsizingResultRow['workloadImpact'],
): (RightsizingResultRow & { clusterId: string })[]
export function workloadResultRows(workload: ScanWorkload): RightsizingResultRow[]
export function workloadResultRows(
  workload: ScanWorkload | DatadogSizingWorkload,
  cluster?: Cluster,
  workloadImpact?: RightsizingResultRow['workloadImpact'],
): RightsizingResultRow[] {
  const byContainer = groupRightsizingRows(workload.rows)
  const { kind, namespace, name, replicas, scaledToZero } = workload
  return [...byContainer].map(([container, rows], index) => {
    const id = [cluster?.id, kind, namespace, name, container].filter(Boolean).join('/')
    const result = {
      id,
      clusterId: cluster?.id,
      clusterName: cluster?.name,
      observedAt: cluster?.observedAt,
      workloadImpact: byContainer.size > 1 && index === 0 ? workloadImpact : undefined,
      kind,
      namespace,
      name,
      container,
      replicas,
      scaledToZero,
      cpu: rows.find((row) => row.resource === 'cpu'),
      memory: rows.find((row) => row.resource === 'memory'),
    }
    if ('source' in workload && workload.source === 'datadog') {
      const actionable = (row: RightsizingRow) => isDatadogRequestActionable(workload, row)
      const impact = calculateImpact(rows, replicas, actionable)
      const review: RightsizingResultRow['review'] = {}
      for (const row of rows) {
        if (actionable(row) || row.queryError || row.fit === 'insufficient_history') continue
        if (!row.recommendedRequest && !workload.reviewReasons?.[container]?.[row.resource]?.length) continue
        const reason = datadogRowReview(workload, row)
        if (reason) review[row.resource] = reason
      }
      let classification: ScanClass = 'in_range'
      if (impact.cpuChange > 0 || impact.memoryChange > 0) classification = 'increase'
      else if (impact.cpuChange < 0 || impact.memoryChange < 0) classification = 'reduction'
      else if (review.cpu || review.memory) classification = 'review'
      else if (rows.some((row) => row.queryError || row.fit === 'insufficient_history'))
        classification = 'need_data'
      return {
        ...result,
        source: workload.source,
        classification,
        impact,
        review,
        workloadReason: index === 0 ? workload.reason : undefined,
      }
    }
    return {
      ...result,
      source: cluster ? 'prometheus' : undefined,
      classification: classifyRows(rows, replicas, scaledToZero),
      impact: calculateImpact(rows, replicas),
    }
  })
}

export function compareScanResults(a: RightsizingResultRow, b: RightsizingResultRow): number {
  return (
    scanPriority(a) - scanPriority(b) ||
    impactScore(b) - impactScore(a) ||
    a.namespace.localeCompare(b.namespace) ||
    a.name.localeCompare(b.name) ||
    a.container.localeCompare(b.container)
  )
}

function impactScore(row: RightsizingResultRow): number {
  return Math.max(
    Math.abs(row.impact.cpuChange) / MIN_CPU_REDUCTION,
    Math.abs(row.impact.memoryChange) / MIN_MEMORY_REDUCTION,
  )
}
