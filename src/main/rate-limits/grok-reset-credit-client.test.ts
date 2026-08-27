import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  net: { fetch: vi.fn() }
}))

import {
  consumeGrokRateLimitResetCreditFromRpc,
  decodeRemainingResetTokens,
  encodeGetRemainingResetsResponse,
  encodeGrpcWebMessage,
  encodeGrpcWebRequest,
  encodeRedeemResetRequest,
  encodeStringField,
  fetchGrokRateLimitResetCredits,
  GROK_REDEEM_RESET_URL,
  GROK_REMAINING_RESETS_URL,
  mapGrokRedeemGrpcStatus,
  mapRemainingResetTokens,
  parseGrpcWebResponse,
  supplementGrokRateLimitResetCredits
} from './grok-reset-credit-client'
import type { GrokAuthSession } from './grok-auth'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'

const LIVE_REMAINING_RESETS_HEX =
  '5221520d726573746f6b5f76705944716fa20106089c80f3d306f20106089cbd96d506'

const session: GrokAuthSession = {
  accessToken: 'access-token',
  userId: 'user-1',
  email: 'dev@example.com',
  teamId: null,
  expiresAtMs: Date.parse('2099-01-01T00:00:00.000Z'),
  oidcClientId: null
}

function grpcResponse(payload: Uint8Array, grpcStatus = '0'): Response {
  const body = encodeGrpcWebMessage(payload, grpcStatus)
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/grpc-web+proto' }),
    arrayBuffer: async () => body.slice().buffer
  } as Response
}

describe('Grok remaining-reset protobuf', () => {
  it('decodes the live GetRemainingResets payload', () => {
    const tokens = decodeRemainingResetTokens(Buffer.from(LIVE_REMAINING_RESETS_HEX, 'hex'))
    expect(tokens).toEqual([
      {
        tokenId: 'restok_vpYDqo',
        grantedAt: Date.parse('2026-08-12T18:49:00.000Z'),
        expiresAt: Date.parse('2026-09-12T18:49:00.000Z')
      }
    ])
    expect(mapRemainingResetTokens(tokens)).toEqual({
      availableCount: 1,
      nextExpiresAt: Date.parse('2026-09-12T18:49:00.000Z'),
      credits: [
        {
          status: 'available',
          grantedAt: Date.parse('2026-08-12T18:49:00.000Z'),
          expiresAt: Date.parse('2026-09-12T18:49:00.000Z')
        }
      ]
    })
  })

  it('round-trips remaining reset tokens', () => {
    const encoded = encodeGetRemainingResetsResponse([
      {
        tokenId: 'restok_vpYDqo',
        grantedAt: Date.parse('2026-08-12T18:49:00.000Z'),
        expiresAt: Date.parse('2026-09-12T18:49:00.000Z')
      }
    ])
    expect(Buffer.from(encoded).toString('hex')).toBe(LIVE_REMAINING_RESETS_HEX)
  })

  it('encodes RedeemReset token_id as protobuf field 10', () => {
    expect(Buffer.from(encodeRedeemResetRequest('restok_INVALID')).toString('hex')).toBe(
      Buffer.from(encodeStringField(10, 'restok_INVALID')).toString('hex')
    )
  })

  it('parses grpc-web trailers for status', () => {
    const raw = encodeGrpcWebMessage(new Uint8Array(), '9')
    expect(parseGrpcWebResponse(raw)).toMatchObject({
      grpcStatus: '9',
      payload: new Uint8Array()
    })
  })

  it('frames an empty GetRemainingResets request as a data-only grpc-web frame', () => {
    expect(Buffer.from(encodeGrpcWebRequest(new Uint8Array())).toString('hex')).toBe('0000000000')
  })
})

describe('mapGrokRedeemGrpcStatus', () => {
  it('maps success and the live redeem error codes', () => {
    expect(mapGrokRedeemGrpcStatus('0', null)).toBe('reset')
    expect(
      mapGrokRedeemGrpcStatus('9', 'The token cannot be redeemed: it does not exist or is expired')
    ).toBe('alreadyRedeemed')
    expect(mapGrokRedeemGrpcStatus('3', 'redeem_reset(), Invalid token_id')).toBe('noCredit')
  })

  it('throws on unexpected grpc failures', () => {
    expect(() => mapGrokRedeemGrpcStatus('13', 'Unexpected EOF decoding stream.')).toThrow(
      /Unexpected EOF/
    )
  })
})

describe('fetchGrokRateLimitResetCredits', () => {
  it('maps a remaining-reset inventory onto rateLimitResetCredits', async () => {
    const request = vi.fn(async () =>
      grpcResponse(
        encodeGetRemainingResetsResponse([
          {
            tokenId: 'restok_vpYDqo',
            grantedAt: Date.parse('2026-08-12T18:49:00.000Z'),
            expiresAt: Date.parse('2026-09-12T18:49:00.000Z')
          }
        ])
      )
    )
    const credits = await fetchGrokRateLimitResetCredits(session, { request })
    expect(credits?.availableCount).toBe(1)
    expect(request).toHaveBeenCalledWith(
      GROK_REMAINING_RESETS_URL,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer access-token',
          'X-XAI-Token-Auth': 'xai-grok-cli',
          'x-userid': 'user-1',
          'Content-Type': 'application/grpc-web+proto'
        })
      })
    )
  })

  it('returns an empty inventory when no tokens remain', async () => {
    const credits = await fetchGrokRateLimitResetCredits(session, {
      request: async () => grpcResponse(new Uint8Array())
    })
    expect(credits).toEqual({ availableCount: 0, nextExpiresAt: null })
  })

  it('returns null when the remaining-resets RPC is not OK', async () => {
    const credits = await fetchGrokRateLimitResetCredits(session, {
      request: async () => grpcResponse(new Uint8Array(), '16')
    })
    expect(credits).toBeNull()
  })
})

describe('supplementGrokRateLimitResetCredits', () => {
  it('leaves non-ok Grok snapshots unchanged', async () => {
    const limits: ProviderRateLimits = {
      provider: 'grok',
      session: null,
      weekly: null,
      updatedAt: 1,
      error: 'failed',
      status: 'error'
    }
    const request = vi.fn()
    await expect(
      supplementGrokRateLimitResetCredits(limits, session, { request })
    ).resolves.toBe(limits)
    expect(request).not.toHaveBeenCalled()
  })
})

describe('consumeGrokRateLimitResetCreditFromRpc', () => {
  it('redeems the soonest-expiring remaining token', async () => {
    const request = vi.fn(async (url: string) => {
      if (url === GROK_REMAINING_RESETS_URL) {
        return grpcResponse(
          encodeGetRemainingResetsResponse([
            {
              tokenId: 'restok_later',
              grantedAt: null,
              expiresAt: Date.parse('2026-09-20T00:00:00.000Z')
            },
            {
              tokenId: 'restok_soon',
              grantedAt: null,
              expiresAt: Date.parse('2026-09-12T00:00:00.000Z')
            }
          ])
        )
      }
      return grpcResponse(new Uint8Array(), '0')
    })

    await expect(consumeGrokRateLimitResetCreditFromRpc(session, { request })).resolves.toBe(
      'reset'
    )
    const redeemCall = request.mock.calls.find((call) => call[0] === GROK_REDEEM_RESET_URL)
    expect(redeemCall).toBeDefined()
    const body = new Uint8Array(redeemCall![1].body as Uint8Array)
    expect(Buffer.from(body).toString('hex')).toContain(
      Buffer.from(encodeRedeemResetRequest('restok_soon')).toString('hex')
    )
  })

  it('returns noCredit when the inventory is empty', async () => {
    const request = vi.fn(async () => grpcResponse(new Uint8Array()))
    await expect(consumeGrokRateLimitResetCreditFromRpc(session, { request })).resolves.toBe(
      'noCredit'
    )
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('maps an already-spent token to alreadyRedeemed', async () => {
    await expect(
      consumeGrokRateLimitResetCreditFromRpc(session, {
        tokenId: 'restok_INVALID',
        request: async () => grpcResponse(new Uint8Array(), '9')
      })
    ).resolves.toBe('alreadyRedeemed')
  })
})
