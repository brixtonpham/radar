import { ArrowRight, Loader2 } from 'lucide-react'
import { Badge } from '../ui/Badge'
import {
  explainRightsizingReasons,
  isDatadogRequestActionable,
} from '../../utils/rightsizing-reasons'
import type {
  RightsizingFit,
  RightsizingRow,
  WorkloadRightsizingEvidence,
  DatadogSizingWorkload,
} from '../../types/rightsizing'

export function RightsizingEvidence({
  data,
  compact = false,
}: {
  data: WorkloadRightsizingEvidence | DatadogSizingWorkload
  compact?: boolean
}) {
  const datadog = 'actionableRequests' in data ? data : undefined
  if (data.rows.length === 0 || (!data.sampleAvailable && !datadog)) {
    return <RightsizingEmptyState text={data.reason ?? 'No rightsizing evidence is available.'} />
  }

  const byContainer = new Map<string, RightsizingRow[]>()
  for (const row of data.rows) {
    const rows = byContainer.get(row.container) ?? []
    rows.push(row)
    byContainer.set(row.container, rows)
  }

  if (compact) {
    return (
      <div className="space-y-2">
        {Array.from(byContainer.entries()).map(([container, rows]) => (
          <div key={container}>
            <div className="mb-1 text-xs font-medium text-theme-text-secondary">{container}</div>
            <div className="space-y-1 pl-2">
              {rows.map((row) => (
                <CompactFitRow key={row.resource} row={row} />
              ))}
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {data.managedBy && (
        <p className="text-xs text-theme-text-secondary">
          Check the {data.managedBy.tool}
          {data.managedBy.name && ` (${data.managedBy.name})`} source before editing. Radar
          identified it from {data.managedBy.signal}.
        </p>
      )}
      {data.reason && <p className="text-sm text-theme-text-secondary">{data.reason}</p>}
      {(data.scaledToZero || data.ownerCoverage === 'current_pods') && (
        <div className="flex flex-wrap gap-2">
          {data.scaledToZero && (
            <Badge severity="neutral" size="sm">
              No current replicas · showing retained evidence
            </Badge>
          )}
          {data.ownerCoverage === 'current_pods' && (
            <Badge severity="info" size="sm">
              Current pods only · confidence capped
            </Badge>
          )}
        </div>
      )}
      {Array.from(byContainer.entries()).map(([container, rows]) => (
        <div key={container}>
          <h4 className="mb-2 text-xs font-semibold text-theme-text-secondary">{container}</h4>
          <div className="grid gap-3 md:grid-cols-2">
            {rows.map((row) => (
              <FitCard
                key={row.resource}
                row={row}
                window={data.window}
                reasons={datadog?.reviewReasons?.[row.container]?.[row.resource]}
                manualReview={
                  !!row.recommendedRequest &&
                  datadog !== undefined &&
                  !isDatadogRequestActionable(datadog, row)
                }
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function FitCard({
  row,
  window,
  manualReview,
  reasons,
}: {
  row: RightsizingRow
  window: string
  manualReview?: boolean
  reasons?: string[]
}) {
  const additionalReasons = reasons?.filter(
    (reason) =>
      reason !== row.recommendationReason &&
      (!row.recommendationReason || reason !== 'recommendation_withheld'),
  )
  return (
    <div className="rounded-md border border-theme-border bg-theme-base/60 p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-theme-text-tertiary">
          {row.resource}
        </span>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <FitBadge fit={row.fit} queryError={row.queryError} />
          {row.hpaManaged && (
            <Badge severity="info" size="sm">
              HPA-managed
            </Badge>
          )}
          {row.bursty && (
            <Badge severity="warning" size="sm">
              Bursty CPU
            </Badge>
          )}
          {row.throttleRatio != null && row.throttleRatio >= 0.1 && (
            <Badge severity="alert" size="sm">
              Throttling observed
            </Badge>
          )}
          {(row.currentPodOOM || row.windowOomEvidence) && (
            <Badge severity="error" size="sm">
              OOM evidence
            </Badge>
          )}
        </div>
      </div>
      <div className="flex items-baseline gap-2 tabular-nums">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-theme-text-quaternary">
            {row.podLevelRequest ? 'Pod-level request' : 'Current request'}
          </div>
          <div className="text-lg font-semibold text-theme-text-primary">
            {row.podLevelRequest ?? row.currentRequest ?? 'Unset'}
          </div>
        </div>
        <ArrowRight className="h-4 w-4 text-theme-text-quaternary" />
        <div>
          <div className="text-[10px] uppercase tracking-wide text-theme-text-quaternary">
            {manualReview ? 'Candidate for manual review' : 'Suggested next step'}
          </div>
          <div className="text-lg font-semibold text-theme-text-primary">
            {row.recommendedRequest ?? '—'}
          </div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 border-t border-theme-border pt-3 text-xs">
        <Metric
          label={`${row.observed?.name ?? (row.resource === 'cpu' ? 'P95' : 'Max')} observed`}
          value={row.observed?.formatted ?? 'No samples'}
        />
        {row.peak && <Metric label={`${row.peak.name} peak`} value={row.peak.formatted} />}
        <Metric
          label={`Evidence · ${window}`}
          value={`${confidenceLabel(row)} · ${Math.round(row.coverage * 100)}% coverage`}
        />
        <Metric
          label="Five-minute samples"
          value={`${row.sampleCount} of ${row.expectedSamples}`}
        />
      </div>
      {manualReview && row.reductionLimited && row.calculatedRequest ? (
        <p className="mt-3 text-xs text-theme-text-tertiary">
          Demand-based target: {row.calculatedRequest}. Review the staged change before editing.
        </p>
      ) : (
        <FitExplanation row={row} />
      )}
      {!!additionalReasons?.length && (
        <p className="mt-1 text-xs text-theme-text-secondary">
          {explainRightsizingReasons(additionalReasons, row.resource)}
        </p>
      )}
    </div>
  )
}

function CompactFitRow({ row }: { row: RightsizingRow }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs tabular-nums text-theme-text-tertiary">
      <span className="w-12 text-[10px] uppercase tracking-wide text-theme-text-quaternary">
        {row.resource}
      </span>
      <span className="min-w-14 text-theme-text-secondary">
        {row.podLevelRequest ? `pod ${row.podLevelRequest}` : (row.currentRequest ?? 'unset')}
      </span>
      {row.recommendedRequest && (
        <>
          <ArrowRight className="h-3 w-3 text-theme-text-quaternary" />
          <span className="min-w-14 text-theme-text-primary">{row.recommendedRequest}</span>
        </>
      )}
      {row.observed && (
        <span className="text-[10px] text-theme-text-quaternary">
          ({row.observed.name} {row.observed.formatted})
        </span>
      )}
      <span className="ml-auto">
        <FitBadge fit={row.fit} queryError={row.queryError} />
      </span>
    </div>
  )
}

function FitBadge({ fit, queryError }: { fit: RightsizingFit; queryError?: string }) {
  const presentation = getRightsizingPresentation(fit, queryError)
  return (
    <Badge severity={presentation.severity} size="sm">
      {presentation.label}
    </Badge>
  )
}

export function getRightsizingPresentation(fit: RightsizingFit, queryError?: string) {
  if (queryError) return { label: 'Query failed', severity: 'error' as const }
  const labels: Record<RightsizingFit, string> = {
    balanced: 'Balanced',
    oversized: 'Oversized',
    under_requested: 'Under-requested',
    missing_request: 'Missing request',
    insufficient_history: 'Insufficient history',
    pod_level_request: 'Pod-level request',
  }
  const severities: Record<RightsizingFit, 'success' | 'info' | 'warning' | 'neutral'> = {
    balanced: 'success',
    oversized: 'info',
    under_requested: 'warning',
    missing_request: 'warning',
    insufficient_history: 'neutral',
    pod_level_request: 'neutral',
  }
  // An older frontend can meet a fit added by a newer agent.
  return { label: labels[fit] ?? fit, severity: severities[fit] ?? ('neutral' as const) }
}

function FitExplanation({ row }: { row: RightsizingRow }) {
  const message = getRightsizingExplanation(row)
  if (!message) return null
  return <p className="mt-3 text-xs text-theme-text-tertiary">{message}</p>
}

export function getRightsizingExplanation(row: RightsizingRow): string | undefined {
  // A denied pod read leaves currentPodOOM unknown rather than false, so it
  // qualifies whatever else is said instead of replacing it — including a
  // staged reduction, which is exactly where an unchecked pod matters most.
  const inventoryNote =
    row.liveInventoryUnavailable && row.resource === 'memory'
      ? "Radar could not read this workload's pods, so it could not check them for out-of-memory restarts."
      : undefined
  const qualified = (base: string) => (inventoryNote ? `${base} ${inventoryNote}` : base)
  if (row.fit === 'pod_level_request' && row.podLevelRequest && !row.queryError)
    return qualified(podLevelRequestExplanation(row, row.podLevelRequest))
  if (row.reductionLimited && row.calculatedRequest && row.recommendedRequest) {
    const burstNote = row.bursty && row.peak ? ` CPU P99 reached ${row.peak.formatted}.` : ''
    return qualified(
      `Demand-based target: ${row.calculatedRequest}. Radar suggests ${row.recommendedRequest} as a conservative next step; observe another full window before reducing further.${burstNote}`,
    )
  }
  const message = row.queryError
    ? `Partial result: ${row.queryError}.`
    : row.recommendationReason &&
      explainRightsizingReasons([row.recommendationReason], row.resource)
  const throttleUnavailable = row.resource === 'cpu' && !row.throttleAvailable
  if (!message && !throttleUnavailable) return inventoryNote
  return qualified(
    message ?? 'CPU throttling metrics are unavailable; no throttling conclusion was drawn.',
  )
}

function podLevelRequestExplanation(row: RightsizingRow, podLevelRequest: string): string {
  const overUse = podLevelOverUseNote(row)
  if (overUse) return overUse
  const resource = row.resource === 'cpu' ? 'CPU' : 'memory'
  const own = row.currentRequest
    ? ` This container's own request (${row.currentRequest}) no longer decides what is reserved.`
    : ''
  return `This pod sets one ${resource} request for all its containers: ${podLevelRequest} in spec.resources. The scheduler reserves that instead of container requests, so Radar doesn't suggest a request per container; check the pod-level request against the usage of its containers.${own}`
}

/**
 * One container's usage above the pod's whole request is a sound lower bound on
 * the pod's own use. Adding containers up would overstate it, so only this case
 * is called out.
 */
export function podLevelOverUseNote(row: RightsizingRow): string | undefined {
  if (
    row.fit !== 'pod_level_request' ||
    row.sampleCount < RIGHTSIZING_MIN_SAMPLES ||
    !row.observed ||
    !row.podLevelRequest ||
    row.podLevelRequestValue == null ||
    row.observed.value <= row.podLevelRequestValue
  )
    return undefined
  const resource = row.resource === 'cpu' ? 'CPU' : 'memory'
  const finding = `This container alone used ${row.observed.formatted} (${row.observed.name}), more than the pod's whole ${row.podLevelRequest} ${resource} request. Radar can't size pod-level requests yet.`
  // An HPA scaling on this resource divides usage by the pod request, so
  // raising it changes scaling; Radar never suggests that unreviewed.
  if (row.hpaManaged)
    return `${finding} The HPA scales on this request, so review its target before raising spec.resources.requests.${row.resource}.`
  if (!row.hpaEvidenceAvailable)
    return `${finding} Radar couldn't check for an HPA on this resource, so check autoscaling before raising spec.resources.requests.${row.resource}.`
  return `${finding} Consider raising spec.resources.requests.${row.resource}.`
}

// Mirrors rightsizingMinSamples (six hours of 5-minute samples) in
// internal/prometheus/rightsizing.go: below it Radar draws no conclusion.
const RIGHTSIZING_MIN_SAMPLES = 72

function confidenceLabel(row: RightsizingRow) {
  return `${row.confidence[0].toUpperCase()}${row.confidence.slice(1)} confidence`
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-theme-text-quaternary">{label}</div>
      <div className="mt-0.5 text-theme-text-secondary">{value}</div>
    </div>
  )
}

export function RightsizingEmptyState({
  text,
  loading = false,
}: {
  text: string
  loading?: boolean
}) {
  return (
    <div className="flex min-h-16 items-center justify-center text-sm text-theme-text-tertiary">
      {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
      {text}
    </div>
  )
}
