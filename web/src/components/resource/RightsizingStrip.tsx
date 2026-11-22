import { ExternalLink, Gauge, HelpCircle } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import {
  RightsizingEvidence,
  RightsizingEmptyState as EmptyState,
} from '@skyhook-io/k8s-ui/components/rightsizing/RightsizingEvidence'
import {
  usePrometheusRightsizing,
  usePrometheusStatus,
  useAutoPromConnect,
  type PrometheusRightsizing,
} from '../../api/client'
import { Tooltip } from '../ui/Tooltip'

const RIGHTSIZING_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet'])
export const RIGHTSIZING_DOCS_URL = 'https://radarhq.io/docs/features/rightsizing'
export const RIGHTSIZING_SUMMARY =
  'Evidence-based guidance for this workload, not a savings estimate or automatic change.'
export const RIGHTSIZING_METHODOLOGY =
  'Uses seven days of 5-minute samples: CPU P95 and memory maximum, plus 15% headroom. Reductions are staged and rounded to practical values; memory reductions also require verifiable restart history. Radar does not change requests.'

interface RightsizingProps {
  kind: string
  namespace: string
  name: string
}

function useRightsizingEvidence({ kind, namespace, name }: RightsizingProps) {
  useAutoPromConnect()
  const { data: status, isLoading: statusLoading } = usePrometheusStatus()
  const connected = status?.connected === true
  const supported = RIGHTSIZING_KINDS.has(kind)
  const query = usePrometheusRightsizing(kind, namespace, name, connected && supported)
  return { connected, supported, statusLoading, ...query }
}

export function ConnectedPrometheusRightsizingPanel(props: RightsizingProps) {
  const status = usePrometheusStatus()
  return status.data?.connected ? (
    <div className="mt-4">
      <RightsizingPanel {...props} />
    </div>
  ) : null
}

export function RightsizingPanel(props: RightsizingProps) {
  const state = useRightsizingEvidence(props)
  const { search } = useLocation()
  if (!state.supported) return null

  return (
    <section className="mx-auto w-full max-w-[1600px] rounded-lg border border-theme-border bg-theme-surface/50">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-theme-border px-4 py-3">
        <div className="flex items-start gap-2">
          <Gauge className="mt-0.5 h-4 w-4 text-theme-text-tertiary" />
          <div>
            <div className="flex items-center gap-1.5">
              <h3 className="text-sm font-semibold text-theme-text-primary">
                Rightsizing · Prometheus
              </h3>
              <Tooltip content={RIGHTSIZING_METHODOLOGY}>
                <HelpCircle className="h-3.5 w-3.5 text-theme-text-tertiary" />
              </Tooltip>
            </div>
            <p className="text-xs text-theme-text-tertiary">
              {RIGHTSIZING_SUMMARY}{' '}
              <a
                href={RIGHTSIZING_DOCS_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-accent-text hover:underline"
              >
                How it works
                <ExternalLink className="h-3 w-3" />
              </a>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {state.data && <RightsizingContext data={state.data} />}
          <Link
            to={{ pathname: '/cost/rightsizing', search }}
            className="text-xs font-medium text-accent-text hover:underline"
          >
            Scan visible workloads
          </Link>
        </div>
      </header>
      <div className="p-4">
        <RightsizingBody state={state} compact={false} />
      </div>
    </section>
  )
}

export function RightsizingStrip(props: RightsizingProps) {
  const state = useRightsizingEvidence(props)
  if (!state.supported || !state.connected || (state.isLoading && !state.data)) return null
  return (
    <section className="mb-3 rounded-lg border border-theme-border bg-theme-surface/40 p-3">
      <header className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-medium text-theme-text-primary">Rightsizing · Prometheus</h3>
          <Tooltip content={RIGHTSIZING_METHODOLOGY}>
            <HelpCircle className="h-3.5 w-3.5 text-theme-text-tertiary" />
          </Tooltip>
        </div>
        {state.data && <RightsizingContext data={state.data} compact />}
      </header>
      <RightsizingBody state={state} compact />
    </section>
  )
}

function RightsizingBody({
  state,
  compact,
}: {
  state: ReturnType<typeof useRightsizingEvidence>
  compact: boolean
}) {
  if (state.statusLoading) {
    return <EmptyState text="Checking Prometheus connection…" loading />
  }
  if (!state.connected) {
    return <EmptyState text="Connect Prometheus to compare requests with observed demand." />
  }
  if (state.isLoading && !state.data) {
    return <EmptyState text="Analyzing seven days of workload demand…" loading />
  }
  if (state.error && !state.data) {
    const message = state.error instanceof Error ? state.error.message : String(state.error)
    return <EmptyState text={`Rightsizing unavailable — ${message}`} />
  }
  if (!state.data) return null
  return <RightsizingEvidence data={state.data} compact={compact} />
}

function RightsizingContext({
  data,
  compact = false,
}: {
  data: PrometheusRightsizing
  compact?: boolean
}) {
  const evidence = data.ownerCoverage === 'ksm_history' ? 'retained ownership' : 'current pods only'
  return (
    <span className="text-[11px] text-theme-text-tertiary">
      {compact ? data.window : `Last ${data.window} · ${evidence}`}
    </span>
  )
}
