import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DatadogSizingWorkload, RightsizingRow } from '../../types/rightsizing'
import { DatadogRightsizingEvidence } from './DatadogRightsizingEvidence'
import { datadogRowReview, isDatadogRequestActionable } from '../../utils/rightsizing-reasons'

const row: RightsizingRow = {
  container: 'api',
  resource: 'cpu',
  fit: 'oversized',
  confidence: 'medium',
  observed: { name: 'P95', formatted: '20m', value: 0.02 },
  peak: { name: 'P99', formatted: '80m', value: 0.08 },
  currentRequest: '1',
  recommendedRequest: '500m',
  coverage: 0.5,
  sampleCount: 1008,
  expectedSamples: 2016,
  hpaManaged: false,
  hpaEvidenceAvailable: true,
  oomEvidenceAvailable: true,
  throttleAvailable: true,
}
const sizing: DatadogSizingWorkload = {
  kind: 'Deployment',
  namespace: 'payments',
  name: 'api',
  source: 'datadog',
  ownerCoverage: 'current_pods',
  scaledToZero: false,
  sampleAvailable: true,
  window: '7d',
  replicas: 2,
  actionableRequests: [],
  rows: [row],
  reviewReasons: { api: { cpu: ['qos_change'] } },
  managedBy: { tool: 'Helm', name: 'payments', signal: 'labels' },
}

describe('workload evidence used by embedded and standalone Radar', () => {
  it('retains measurements, the declared manager and the server’s guarded recommendation', () => {
    const html = renderToStaticMarkup(
      <DatadogRightsizingEvidence
        detail={{ configured: true, workloadUID: 'id', templateHash: 'hash', rightsizing: sizing }}
        refreshing={false}
        verify={vi.fn()}
        onVerified={vi.fn()}
        onVerifyError={vi.fn()}
      />,
    )
    for (const text of [
      '2 current replicas',
      '50% coverage',
      '1008 of 2016',
      'P99 peak',
      '80m',
      'Helm',
      'payments',
      'labels',
      'Candidate for manual review',
      'Guaranteed QoS',
    ]) {
      expect(html).toContain(text)
    }
    expect(html).not.toContain('Copy request diff')
    expect(isDatadogRequestActionable(sizing, row)).toBe(false)
    expect(datadogRowReview(sizing, row)).toContain('Guaranteed QoS')
  })
})
