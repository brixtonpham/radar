import type { DatadogSizingWorkload, RightsizingRow } from '../types/rightsizing'

const reasonText: Record<string, string> = {
  request_within_fit_range: 'The configured request is within 30% of the evidence-based target.',
  insufficient_history: 'At least six hours of samples are required before suggesting a request.',
  hpa_managed: 'This request affects the horizontal autoscaler.',
  hpa_evidence_unavailable:
    'Radar could not verify HPA ownership. Check permission to list HorizontalPodAutoscalers in this namespace.',
  oom_evidence: 'A lower memory request is withheld because OOM evidence exists.',
  oom_evidence_unavailable:
    'Radar could not verify recent OOM history, so it withheld a lower memory request.',
  recommended_request_exceeds_limit:
    'The evidence-based request would exceed the current limit; review the limit first.',
  requests_exceed_pod_limit:
    "Together with the other containers' requests and suggested increases, this request would take the pod above its pod-level limit (spec.resources), which Kubernetes rejects. Decide how to split the limit between containers, or raise the pod limit.",
  qos_unavailable: 'Verify the current pods’ QoS class before changing this request.',
  qos_change: 'Changing the request could move pods out of the Guaranteed QoS class.',
  low_confidence_reduction:
    'Too few measurements cover this window to recommend reducing the request.',
  bursty_reduction: 'CPU usage has short peaks.',
  throttled_reduction: 'The container is CPU throttled.',
  current_pod_oom: 'A current pod reported an out-of-memory termination.',
  oom_in_window: 'There is evidence of an out-of-memory termination during the window.',
  limit_conflict: 'The suggestion conflicts with the resource limit.',
  recommendation_withheld: 'Safety evidence is incomplete.',
  pod_level_request: 'The pod sets a shared resource request.',
}

export function explainRightsizingReasons(
  reasons: string[],
  resource?: RightsizingRow['resource'],
): string {
  return [...new Set(reasons)]
    .map((reason) => {
      if (resource && reason === 'hpa_managed')
        return `The HPA manages ${resource}; review its target before changing this request.`
      return reasonText[reason] ?? reason.replaceAll('_', ' ')
    })
    .join(' ')
}

export function isDatadogRequestActionable(
  sizing: DatadogSizingWorkload,
  row: RightsizingRow,
): boolean {
  return sizing.actionableRequests.some(
    (item) => item.container === row.container && item.resource === row.resource,
  )
}

export function datadogRowReview(
  sizing: DatadogSizingWorkload,
  row: RightsizingRow,
): string | undefined {
  if (row.queryError) return row.queryError
  const reasons = sizing.reviewReasons?.[row.container]?.[row.resource] ?? []
  const codes = row.recommendationReason
    ? [
        row.recommendationReason,
        ...reasons.filter((reason) => reason !== 'recommendation_withheld'),
      ]
    : reasons
  if (codes.length) return explainRightsizingReasons(codes, row.resource)
  if (row.recommendedRequest && !isDatadogRequestActionable(sizing, row))
    return 'Review this request manually before changing it.'
}
