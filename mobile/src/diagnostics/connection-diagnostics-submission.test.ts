import { describe, expect, it, vi } from 'vitest'
import { submitConnectionDiagnostics } from './connection-diagnostics-submission'

describe('submitConnectionDiagnostics', () => {
  it('sends a bounded report through the diagnostics lane', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
    const result = await submitConnectionDiagnostics(
      { report: 'x'.repeat(100_000), appVersion: '0.0.47', platform: 'android 36' },
      fetchImpl
    )

    expect(result).toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://www.onorca.dev/v1/feedback',
      expect.objectContaining({ method: 'POST' })
    )
    const request = fetchImpl.mock.calls[0]?.[1]
    const body = JSON.parse(String(request?.body)) as { feedback: string; submissionType: string }
    expect(body.submissionType).toBe('connection_diagnostics')
    expect(body.feedback.length).toBeLessThanOrEqual(64 * 1024)
  })

  it('returns a safe failure for a rejected response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }))
    await expect(
      submitConnectionDiagnostics(
        { report: 'report', appVersion: '0.0.47', platform: 'android' },
        fetchImpl
      )
    ).resolves.toEqual({ ok: false, error: 'status 503' })
  })
})
