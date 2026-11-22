import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DatadogSizingWorkload, RightsizingRow } from '../../types/rightsizing'
import { FitWhy, RightsizingResultsTable } from './RightsizingResultsTable'
import { workloadResultRows } from './results-model'

const cpu: RightsizingRow = {
  container: 'app',
  resource: 'cpu',
  fit: 'oversized',
  confidence: 'high',
  currentRequest: '500m',
  currentRequestValue: 0.5,
  recommendedRequest: '200m',
  recommendedRequestValue: 0.2,
  observed: { name: 'P95', value: 0.15, formatted: '150m' },
  sampleCount: 1512,
  expectedSamples: 2016,
  coverage: 0.75,
  hpaManaged: false,
  hpaEvidenceAvailable: true,
  oomEvidenceAvailable: true,
}
const workload: DatadogSizingWorkload = {
  kind: 'Deployment',
  name: 'checkout',
  namespace: 'payments',
  replicas: 2,
  rows: [cpu],
  scaledToZero: false,
  window: '7d',
  ownerCoverage: 'current_pods',
  source: 'datadog',
  sampleAvailable: true,
  actionableRequests: [],
}

describe('operator rightsizing results across clusters', () => {
  it('keeps cluster identity in the list, row selection and workload link', () => {
    const a = workloadResultRows(workload, { id: 'a', name: 'East' })
    const b = workloadResultRows(workload, { id: 'b', name: 'East' })
    expect(a[0].id).not.toBe(b[0].id)
    const html = renderToStaticMarkup(
      <RightsizingResultsTable
        rows={[...a, ...b]}
        openRowId={b[0].id}
        onOpenRowChange={() => {}}
        renderWorkloadLink={(row) => <a href={`/c/${row.clusterId}/workload`}>Open workload</a>}
      />,
    )
    expect(html).toContain('East (a) · ')
    expect(html).toContain('East (b) · ')
    expect(html).toContain('href="/c/b/workload"')
    expect(html).not.toContain('href="/c/a/workload"')
  })

  it('shows withheld resources as review-only and counts only admitted container requests', () => {
    const memory: RightsizingRow = {
      ...cpu,
      resource: 'memory',
      fit: 'under_requested',
      currentRequest: '64Mi',
      currentRequestValue: 64 * 1024 ** 2,
      recommendedRequest: '128Mi',
      recommendedRequestValue: 128 * 1024 ** 2,
    }
    const rows = workloadResultRows(
      {
        ...workload,
        rows: [cpu, memory, { ...cpu, container: 'proxy' }],
        actionableRequests: [{ container: 'app', resource: 'memory' }],
        reviewReasons: { app: { cpu: ['qos_change'] } },
      },
      { id: 'one', name: 'East' },
      { cpuChange: 0, memoryChange: 128 * 1024 ** 2 },
    )
    expect(rows.map((row) => [row.container, row.classification])).toEqual([
      ['app', 'increase'],
      ['proxy', 'review'],
    ])
    expect(rows[0].impact).toEqual({ cpuChange: 0, memoryChange: 128 * 1024 ** 2, replicas: 2 })
    expect(rows[1].impact.cpuChange).toBe(0)
    const html = renderToStaticMarkup(
      <RightsizingResultsTable
        rows={rows}
        openRowId={rows[0].id}
        onOpenRowChange={() => {}}
        renderWorkloadLink={() => null}
      />,
    )
    expect(html).toContain('Review before changing')
    expect(html).toContain('CPU request needs review')
    expect(html).toContain('Guaranteed QoS')
    expect(html).toContain('1512 of 2016 expected 5-minute samples')
    expect(html).toContain('64Mi → 128Mi')
    expect(html).toContain('Whole workload · +128Mi memory requested')
    expect(html.match(/Whole workload/g)).toHaveLength(1)
    expect(html).not.toContain('200m')
    expect(html).not.toContain('Reduce request')
  })

  it('keeps the vendor read error and retry instructions scoped to the host', () => {
    const row = { ...cpu, queryError: 'usage query failed' }
    const cloud = renderToStaticMarkup(<FitWhy label="CPU" row={row} source="datadog" />)
    expect(cloud).toContain('Open the workload to retry')
    expect(cloud).not.toContain('top bar')
    const local = renderToStaticMarkup(<FitWhy label="CPU" row={row} />)
    expect(local).toContain('select fewer namespaces in the top bar')
  })

  it('shows the workload measurement gap once even when containers have rows', () => {
    const missing: RightsizingRow = {
      ...cpu,
      fit: 'insufficient_history',
      sampleCount: 0,
      coverage: 0,
      recommendedRequest: undefined,
      recommendedRequestValue: undefined,
    }
    const rows = workloadResultRows(
      {
        ...workload,
        sampleAvailable: false,
        reason: 'No complete five-minute measurements for the current Pods and containers.',
        rows: [missing, { ...missing, container: 'proxy' }],
      },
      { id: 'one', name: 'East' },
    )
    const html = renderToStaticMarkup(
      <RightsizingResultsTable
        rows={rows}
        openRowId={null}
        onOpenRowChange={() => {}}
        renderWorkloadLink={() => null}
      />,
    )
    expect(html.match(/No complete five-minute measurements/g)).toHaveLength(1)
    expect(html).toContain('Insufficient usage evidence')
    expect(html).not.toContain('No suggested change')
  })

  it('keeps missing data separate from an evaluated request within the fit range', () => {
    const rows = workloadResultRows(
      {
        ...workload,
        rows: [
          {
            ...cpu,
            recommendedRequest: undefined,
            recommendedRequestValue: undefined,
            fit: 'balanced',
            recommendationReason: 'request_within_fit_range',
          },
          {
            ...cpu,
            container: 'worker',
            fit: 'insufficient_history',
            recommendedRequest: undefined,
            recommendedRequestValue: undefined,
          },
        ],
      },
      { id: 'one', name: 'East' },
    )
    expect(rows.map((row) => row.classification)).toEqual(['in_range', 'need_data'])
  })
})
