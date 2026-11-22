import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { copyText } from '@skyhook-io/k8s-ui/utils/clipboard'
import { fetchJSON, useRadarFeature } from '../../api/client'
import { getApiBase } from '../../api/config'
import { ConnectedPrometheusRightsizingPanel, RightsizingEvidence, type RightsizingEvidenceData } from './RightsizingStrip'

interface SizingDetail {
  configured: boolean
  rightsizing?: RightsizingEvidenceData & { actionableRequests: { container: string; resource: string }[] }
  workloadUID?: string
  templateHash?: string
  manifestDiff?: string
}

export function DatadogRightsizingPanel({ kind, namespace, name }: { kind: string; namespace: string; name: string }) {
  const { support } = useRadarFeature('datadogRightsizing')
  const path = '/metrics/datadog/rightsizing/' + [kind, namespace, name].map(encodeURIComponent).join('/')
  const queryKey = ['datadog-rightsizing', getApiBase(), path]
  const client = useQueryClient()
  const query = useQuery({
    queryKey,
    enabled: support === 'supported',
    queryFn: ({ signal }) => fetchJSON<SizingDetail>(path, signal),
    staleTime: 2 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const [copying, setCopying] = useState(false)
  const [message, setMessage] = useState('')
  const pendingCopy = useRef<AbortController | null>(null)
  useEffect(() => () => pendingCopy.current?.abort(), [path])
  const detail = query.data

  async function copyDiff() {
    if (copying || !detail?.workloadUID || !detail.templateHash || !detail.manifestDiff) return
    setCopying(true)
    setMessage('')
    const controller = new AbortController()
    pendingCopy.current = controller
    try {
      const params = new URLSearchParams({ workloadUID: detail.workloadUID, templateHash: detail.templateHash })
      const fresh = await fetchJSON<SizingDetail>(path + '?' + params, controller.signal)
      if (controller.signal.aborted) return
      client.setQueryData(queryKey, fresh)
      if (!fresh.configured || !fresh.manifestDiff || fresh.workloadUID !== detail.workloadUID ||
          fresh.templateHash !== detail.templateHash || fresh.manifestDiff !== detail.manifestDiff) {
        setMessage('The recommendation changed. Review the latest evidence before copying.')
        return
      }
      setMessage(await copyText(fresh.manifestDiff) ? 'Manifest diff copied.' : 'Clipboard unavailable. Select the diff to copy it manually.')
    } catch (error) {
      if (controller.signal.aborted) return
      setMessage(error instanceof Error ? error.message : 'Could not copy the manifest diff.')
      void query.refetch()
    } finally {
      if (!controller.signal.aborted) setCopying(false)
    }
  }

  if (support === 'unsupported') {
    return <><p className="mt-4 text-sm text-theme-text-secondary">Upgrade this cluster’s Radar agent to see Datadog rightsizing.</p>
      <ConnectedPrometheusRightsizingPanel {...{ kind, namespace, name }} /></>
  }
  if (support === 'unknown' || (!query.error && detail?.configured === false)) return null
  return (
    <section className="mt-4 rounded-lg border border-theme-border bg-theme-surface p-3">
      <h3 className="text-sm font-medium text-theme-text-primary">Rightsizing</h3>
      {query.error ? <p role="alert" className="mt-2 text-sm text-theme-text-secondary">{query.error.message} <button type="button" className="text-accent hover:underline" onClick={() => void query.refetch()}>Retry</button></p>
        : !detail?.rightsizing ? <p role="status" className="mt-2 text-sm text-theme-text-secondary">Checking workload demand…</p>
        : <>
          <p className="mb-3 text-xs text-theme-text-secondary">Datadog · Seven-day lookback · Verified current replicas</p>
          <RightsizingEvidence data={detail.rightsizing} actionableRequests={detail.rightsizing.actionableRequests} />
          {detail.manifestDiff && (
            <div className="mt-3 border-t border-theme-border pt-3">
              <h4 className="text-xs font-medium text-theme-text-secondary">Suggested request changes</h4>
              <pre className="my-2 overflow-x-auto rounded-md bg-theme-base p-2 text-xs">{detail.manifestDiff}</pre>
              <button type="button" className="btn-brand-outline btn-sm" disabled={copying} onClick={() => void copyDiff()}>
                {copying ? 'Verifying…' : 'Copy manifest diff'}
              </button>
            </div>
          )}
        </>}
      {message && <p role="status" className="mt-2 text-xs text-theme-text-secondary">{message}</p>}
    </section>
  )
}
