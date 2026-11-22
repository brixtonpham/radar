import { useLayoutEffect, useRef, useState } from 'react'
import type { DatadogSizingDetail } from '../../types/rightsizing'
import { copyText } from '../../utils/clipboard'
import { Disclosure } from '../ui/Disclosure'
import { RightsizingEvidence } from './RightsizingEvidence'

type AuthorizedDetail = Extract<DatadogSizingDetail, { configured: true }>

interface DatadogRightsizingEvidenceProps {
  detail: AuthorizedDetail
  refreshing: boolean
  verify: (
    subject: Pick<AuthorizedDetail, 'workloadUID' | 'templateHash'>,
    signal: AbortSignal,
  ) => Promise<DatadogSizingDetail>
  onVerified: (fresh: DatadogSizingDetail) => void
  onVerifyError: (error: unknown) => void
}

export function DatadogRightsizingEvidence({
  detail,
  refreshing,
  verify,
  onVerified,
  onVerifyError,
}: DatadogRightsizingEvidenceProps) {
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState('')
  const pending = useRef<AbortController | null>(null)
  const { rightsizing, workloadUID, templateHash, manifestDiff } = detail
  useLayoutEffect(() => {
    setChecking(false)
    return () => {
      pending.current?.abort()
      pending.current = null
    }
  }, [workloadUID, templateHash, manifestDiff])

  async function copyDiff() {
    if (pending.current || refreshing || !manifestDiff) return
    const controller = new AbortController()
    pending.current = controller
    setChecking(true)
    setMessage('')
    try {
      const fresh = await verify({ workloadUID, templateHash }, controller.signal)
      if (controller.signal.aborted) return
      onVerified(fresh)
      if (
        !fresh.configured ||
        fresh.workloadUID !== workloadUID ||
        fresh.templateHash !== templateHash ||
        fresh.manifestDiff !== manifestDiff
      ) {
        setMessage('The recommendation changed. Review the refreshed diff before copying.')
        return
      }
      if (controller.signal.aborted) return
      const copied = await copyText(fresh.manifestDiff)
      if (!controller.signal.aborted)
        setMessage(
          copied ? 'Diff copied.' : 'Clipboard unavailable. Select the diff to copy it manually.',
        )
    } catch (error) {
      if (controller.signal.aborted) return
      setMessage(error instanceof Error ? error.message : 'Could not verify the request diff.')
      onVerifyError(error)
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null
        setChecking(false)
      }
    }
  }

  return (
    <div className="mt-2 space-y-3">
      <p className="text-xs text-theme-text-secondary">
        Datadog · {rightsizing.window} lookback · {rightsizing.replicas} current{' '}
        {rightsizing.replicas === 1 ? 'replica' : 'replicas'}. Measurements cover the current Pods
        since their creation. Rollouts and restarts can reduce coverage.
      </p>
      <RightsizingEvidence data={rightsizing} />
      {manifestDiff && (
        <div className="border-t border-theme-border pt-3">
          <Disclosure summary="Review request diff">
            {!rightsizing.managedBy && (
              <p className="my-2 text-xs text-theme-text-secondary">
                Update the manifest or chart values that deploy this workload.
              </p>
            )}
            <pre className="my-2 overflow-x-auto rounded-md bg-theme-base p-2 text-xs">
              {manifestDiff}
            </pre>
            <button
              type="button"
              className="btn-brand-outline btn-sm"
              disabled={checking || refreshing}
              onClick={() => void copyDiff()}
            >
              {checking ? 'Verifying workload…' : 'Copy request diff'}
            </button>
          </Disclosure>
        </div>
      )}
      {message && (
        <p role="status" className="text-xs text-theme-text-secondary">
          {message}
        </p>
      )}
    </div>
  )
}
