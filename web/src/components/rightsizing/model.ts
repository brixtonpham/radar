import type { RightsizingScanResponse } from '../../api/client'
import {
  compareScanResults,
  workloadResultRows,
  type RightsizingResultRow,
  type ScanClass,
} from '@skyhook-io/k8s-ui/components/rightsizing/results-model'

export type { ScanClass } from '@skyhook-io/k8s-ui/components/rightsizing/results-model'

export interface RightsizingScanRow extends RightsizingResultRow {
  system: boolean
}

export function flattenScanResults(scan: RightsizingScanResponse): RightsizingScanRow[] {
  return scan.workloads
    .flatMap((workload) =>
      workloadResultRows(workload).map((row) => ({
        ...row,
        system: isSystemNamespace(row.namespace),
      })),
    )
    .sort(compareScanResults)
}

export function scanClassCounts(rows: RightsizingScanRow[]): Record<ScanClass, number> {
  const counts: Record<ScanClass, number> = {
    increase: 0,
    reduction: 0,
    review: 0,
    in_range: 0,
    need_data: 0,
  }
  for (const row of rows) counts[row.classification]++
  return counts
}

export function isActionableClass(value: ScanClass): boolean {
  return value === 'increase' || value === 'reduction' || value === 'review'
}

function isSystemNamespace(namespace: string): boolean {
  return (
    namespace === 'kube-system' ||
    namespace === 'kube-public' ||
    namespace === 'kube-node-lease' ||
    namespace.startsWith('gke-managed-')
  )
}
