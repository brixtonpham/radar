// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { copyText } from '@skyhook-io/k8s-ui/utils/clipboard'
import { DatadogRightsizingPanel } from './DatadogRightsizingPanel'
import { ApiError } from '../../api/client'
import { getApiBase } from '../../api/config'

const state = vi.hoisted(() => ({ fetch: vi.fn(), support: 'supported' }))
vi.mock('../../api/client', async (importOriginal) => ({
  ApiError: (await importOriginal<typeof import('../../api/client')>()).ApiError,
  fetchJSON: (...args: unknown[]) => state.fetch(...args),
  usePrometheusStatus: () => ({ data: { connected: false } }),
  useRadarFeature: () => ({ support: state.support }),
}))
vi.mock('@skyhook-io/k8s-ui/utils/clipboard', () => ({ copyText: vi.fn(async () => true) }))
const detail = {
  configured: true,
  templateHash: 'a',
  workloadUID: 'uid',
  manifestDiff: '- 500m\n+ 250m',
  rightsizing: {
    rows: [],
    actionableRequests: [],
    sampleAvailable: false,
    reason: 'Insufficient history',
    window: '7d',
  },
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

async function clickCopy() {
  await act(async () =>
    Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent === 'Review request diff')!
      .click(),
  )
  await act(async () =>
    Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent === 'Copy request diff')!
      .click(),
  )
}

async function render(name = 'api') {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <DatadogRightsizingPanel kind="Deployment" namespace="team" name={name} />
      </QueryClientProvider>,
    ),
  )
}
it('skips sizing reads for spokes without the feature', async () => {
  state.support = 'unsupported'
  await render()
  expect(host.textContent).toContain('Upgrade this cluster')
  expect(state.fetch).not.toHaveBeenCalled()
})

it.each([false, true])(
  'copies only if a fresh authorized diff matches the preview (changed=%s)',
  async (changed) => {
    state.fetch
      .mockResolvedValueOnce(detail)
      .mockResolvedValueOnce(changed ? { ...detail, manifestDiff: '- 500m\n+ 350m' } : detail)
    await render()
    await vi.waitFor(() => expect(host.textContent).toContain('Copy request diff'))
    await clickCopy()
    const calls = state.fetch.mock.calls
    expect(calls[1][0]).toBe(
      '/metrics/datadog/rightsizing/Deployment/team/api?workloadUID=uid&templateHash=a',
    )
    if (changed) {
      expect(copyText).not.toHaveBeenCalled()
      expect(host.textContent).toContain('recommendation changed')
      await vi.waitFor(() => expect(host.textContent).toContain('350m'))
    } else {
      expect(copyText).toHaveBeenCalledWith(detail.manifestDiff)
    }
  },
)

it('explains revoked approval and removes the diff', async () => {
  state.fetch.mockResolvedValueOnce(detail).mockResolvedValueOnce({ configured: false })
  await render()
  await vi.waitFor(() => expect(host.textContent).toContain('Copy request diff'))
  await clickCopy()
  await vi.waitFor(() => expect(host.textContent).toContain('no longer enabled'))
  expect(host.textContent).not.toContain('Copy request diff')
  expect(copyText).not.toHaveBeenCalled()
})

it('drops a pending copy when moving to another workload', async () => {
  let resolve!: (value: typeof detail) => void
  state.fetch
    .mockResolvedValueOnce(detail)
    .mockReturnValueOnce(
      new Promise<typeof detail>((done) => {
        resolve = done
      }),
    )
    .mockResolvedValueOnce({ configured: false })
  await render()
  await vi.waitFor(() => expect(host.textContent).toContain('Review request diff'))
  await clickCopy()
  const signal = state.fetch.mock.calls[1][1] as AbortSignal
  await render('other')
  expect(signal.aborted).toBe(true)
  await act(async () => resolve(detail))
  expect(copyText).not.toHaveBeenCalled()
})

it('clears the cached preview when the verification read is denied', async () => {
  const denial = new ApiError('Kubernetes denied this read', 403)
  state.fetch
    .mockResolvedValueOnce(detail)
    .mockRejectedValueOnce(denial)
    .mockRejectedValueOnce(denial)
  await render()
  await vi.waitFor(() => expect(host.textContent).toContain('Review request diff'))
  await clickCopy()
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Kubernetes denied this read',
    ),
  )
  expect(host.textContent).not.toContain(detail.manifestDiff)
  expect(copyText).not.toHaveBeenCalled()
})

it('retains an identity conflict explanation after a fresh workload read succeeds', async () => {
  const conflict = new ApiError('The workload template changed', 409)
  state.fetch
    .mockResolvedValueOnce(detail)
    .mockRejectedValueOnce(conflict)
    .mockResolvedValueOnce({
      ...detail,
      templateHash: 'new',
      manifestDiff: '- 500m\n+ 450m',
    })
  await render()
  await vi.waitFor(() => expect(host.textContent).toContain('Review request diff'))
  await clickCopy()
  await vi.waitFor(() => expect(host.textContent).toContain('450m'))
  expect(host.textContent).toContain(
    'Could not verify the request diff. The workload template changed',
  )
  expect(host.textContent).not.toContain(detail.manifestDiff)
  expect(copyText).not.toHaveBeenCalled()
})

it('clears the clipboard success message when a background refresh replaces the diff', async () => {
  state.fetch.mockResolvedValue(detail)
  await render()
  await vi.waitFor(() => expect(host.textContent).toContain('Review request diff'))
  await clickCopy()
  expect(host.textContent).toContain('Diff copied.')
  await act(async () => {
    client.setQueryData(
      ['datadog-rightsizing', getApiBase(), '/metrics/datadog/rightsizing/Deployment/team/api'],
      { ...detail, manifestDiff: '- 500m\n+ 450m' },
    )
  })
  await vi.waitFor(() => expect(host.textContent).toContain('450m'))
  expect(host.textContent).not.toContain('Diff copied.')
})
