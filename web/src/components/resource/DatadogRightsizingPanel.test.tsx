// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { copyText } from '@skyhook-io/k8s-ui/utils/clipboard'
import { DatadogRightsizingPanel } from './DatadogRightsizingPanel'

const state = vi.hoisted(() => ({ fetch: vi.fn(), support: 'supported' }))
vi.mock('../../api/client', () => ({
  fetchJSON: (...args: unknown[]) => state.fetch(...args),
  usePrometheusStatus: () => ({ data: { connected: false } }),
  useRadarFeature: () => ({ support: state.support }),
}))
vi.mock('@skyhook-io/k8s-ui/utils/clipboard', () => ({ copyText: vi.fn(async () => true) }))
const detail = {
  configured: true, templateHash: 'a', workloadUID: 'uid', manifestDiff: '- 500m\n+ 250m',
  rightsizing: { rows: [], actionableRequests: [], sampleAvailable: false, reason: 'Insufficient history', window: '7d' },
}
let root: ReturnType<typeof createRoot>
let client: QueryClient
let host: HTMLDivElement

beforeEach(() => {
  state.support = 'supported'
  state.fetch.mockReset()
  vi.mocked(copyText).mockClear()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div')
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  client.clear()
})

async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}>
    <DatadogRightsizingPanel kind="Deployment" namespace="team" name="api" />
  </QueryClientProvider>))
}
it('skips sizing reads for spokes without the feature', async () => {
  state.support = 'unsupported'
  await render()
  expect(host.textContent).toContain('Upgrade this cluster')
  expect(state.fetch).not.toHaveBeenCalled()
})

it.each([false, true])('copies only if a fresh authorized diff matches the preview (changed=%s)', async changed => {
  state.fetch.mockResolvedValueOnce(detail).mockResolvedValueOnce(changed ? { ...detail, manifestDiff: '- 500m\n+ 350m' } : detail)
  await render()
  await vi.waitFor(() => expect(host.textContent).toContain('Copy manifest diff'))
  await act(async () => host.querySelector('button')!.click())
  const calls = state.fetch.mock.calls
  expect(calls[1][0]).toBe('/metrics/datadog/rightsizing/Deployment/team/api?workloadUID=uid&templateHash=a')
  if (changed) {
    expect(copyText).not.toHaveBeenCalled()
    expect(host.textContent).toContain('recommendation changed')
    expect(host.textContent).toContain('350m')
  } else {
    expect(copyText).toHaveBeenCalledWith(detail.manifestDiff)
  }
})
