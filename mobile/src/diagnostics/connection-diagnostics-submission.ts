const CONNECTION_DIAGNOSTICS_ENDPOINT = 'https://www.onorca.dev/v1/feedback'
const SUBMISSION_TIMEOUT_MS = 10_000
const MAX_SUBMISSION_BYTES = 64 * 1024

export type ConnectionDiagnosticsSubmission = {
  report: string
  appVersion: string
  platform: string
}

export type ConnectionDiagnosticsSubmissionResult = { ok: true } | { ok: false; error: string }

/** Sends only the already-redacted, bounded report after an explicit user tap. */
export async function submitConnectionDiagnostics(
  submission: ConnectionDiagnosticsSubmission,
  fetchImpl: typeof fetch = fetch
): Promise<ConnectionDiagnosticsSubmissionResult> {
  const report = submission.report.slice(0, MAX_SUBMISSION_BYTES)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SUBMISSION_TIMEOUT_MS)
  try {
    const response = await fetchImpl(CONNECTION_DIAGNOSTICS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feedback: report,
        submissionType: 'connection_diagnostics',
        githubLogin: null,
        githubEmail: null,
        appVersion: submission.appVersion,
        platform: `mobile-${submission.platform}`,
        osRelease: 'unknown',
        arch: 'unknown'
      }),
      signal: controller.signal
    })
    return response.ok ? { ok: true } : { ok: false, error: `status ${response.status}` }
  } catch (error) {
    return {
      ok: false,
      error: controller.signal.aborted
        ? 'request timed out'
        : error instanceof Error
          ? error.message
          : 'request failed'
    }
  } finally {
    clearTimeout(timeout)
  }
}
