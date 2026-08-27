import { net } from 'electron'
import type { CodexRateLimitResetOutcome, ProviderRateLimits } from '../../shared/rate-limit-types'
import type { RateLimitResetCredits } from './codex-reset-credit-client'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import type { GrokAuthSession } from './grok-auth'
import {
  decodeRemainingResetTokens,
  encodeGrpcWebRequest,
  encodeRedeemResetRequest,
  mapRemainingResetTokens,
  parseGrpcWebResponse,
  type GrokRemainingResetToken
} from './grok-reset-credit-proto'

export {
  decodeRemainingResetTokens,
  encodeGetRemainingResetsResponse,
  encodeGrpcWebMessage,
  encodeGrpcWebRequest,
  encodeRedeemResetRequest,
  encodeStringField,
  mapRemainingResetTokens,
  parseGrpcWebResponse
} from './grok-reset-credit-proto'
export type { GrokRemainingResetToken } from './grok-reset-credit-proto'

const GROK_WEB_ORIGIN = 'https://grok.com'
export const GROK_REMAINING_RESETS_URL =
  `${GROK_WEB_ORIGIN}/prod_mc_billing.ConsumerUiSvc/GetRemainingResets`
export const GROK_REDEEM_RESET_URL =
  `${GROK_WEB_ORIGIN}/prod_mc_billing.ConsumerUiSvc/RedeemReset`

const GROK_CLI_AUTH_HEADER = 'xai-grok-cli'
const FETCH_TIMEOUT_MS = 10_000
const REDEEM_TIMEOUT_MS = 30_000

export type GrokRpcRequest = (url: string, init: RequestInit) => Promise<Response>

function grokRpcHeaders(session: GrokAuthSession): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
    'X-XAI-Token-Auth': GROK_CLI_AUTH_HEADER,
    Origin: GROK_WEB_ORIGIN,
    Referer: `${GROK_WEB_ORIGIN}/?_s=usage`,
    'Content-Type': 'application/grpc-web+proto',
    'x-grpc-web': '1',
    Accept: '*/*',
    'x-user-agent': 'connect-es/1.6.1',
    'User-Agent':
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
  }
  if (session.userId) {
    headers['x-userid'] = session.userId
  }
  return headers
}

function defaultGrokRpcRequest(url: string, init: RequestInit): Promise<Response> {
  return net.fetch(url, init)
}

function headerValue(headers: Headers | undefined, name: string): string | null {
  return typeof headers?.get === 'function' ? headers.get(name) : null
}

async function postGrokRpc(
  url: string,
  session: GrokAuthSession,
  payload: Uint8Array,
  options: { signal?: AbortSignal; timeoutMs: number; request?: GrokRpcRequest }
): Promise<{ payload: Uint8Array; grpcStatus: string; grpcMessage: string | null }> {
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const request = options.request ?? defaultGrokRpcRequest
  const response = await request(url, {
    method: 'POST',
    headers: grokRpcHeaders(session),
    body: encodeGrpcWebRequest(payload),
    signal
  })
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    throw new Error(`Grok reset request failed (HTTP ${response.status})`)
  }
  const raw = new Uint8Array(await response.arrayBuffer())
  return parseGrpcWebResponse(
    raw,
    headerValue(response.headers, 'grpc-status'),
    headerValue(response.headers, 'grpc-message')
  )
}

export async function fetchGrokRateLimitResetCredits(
  session: GrokAuthSession,
  options: { signal?: AbortSignal; request?: GrokRpcRequest } = {}
): Promise<RateLimitResetCredits | null> {
  if (options.signal?.aborted) {
    return null
  }
  try {
    const rpc = await postGrokRpc(GROK_REMAINING_RESETS_URL, session, new Uint8Array(), {
      signal: options.signal,
      timeoutMs: FETCH_TIMEOUT_MS,
      request: options.request
    })
    if (rpc.grpcStatus !== '0') {
      return null
    }
    return mapRemainingResetTokens(decodeRemainingResetTokens(rpc.payload))
  } catch {
    return null
  }
}

export async function supplementGrokRateLimitResetCredits(
  limits: ProviderRateLimits,
  session: GrokAuthSession,
  options: { signal?: AbortSignal; request?: GrokRpcRequest } = {}
): Promise<ProviderRateLimits> {
  if (options.signal?.aborted || limits.provider !== 'grok' || limits.status !== 'ok') {
    return limits
  }
  const rateLimitResetCredits = await fetchGrokRateLimitResetCredits(session, options)
  return rateLimitResetCredits === null ? limits : { ...limits, rateLimitResetCredits }
}

function selectRedeemableToken(tokens: GrokRemainingResetToken[]): GrokRemainingResetToken | null {
  const sorted = [...tokens].sort((left, right) => {
    const leftExpiry = left.expiresAt ?? Number.POSITIVE_INFINITY
    const rightExpiry = right.expiresAt ?? Number.POSITIVE_INFINITY
    return leftExpiry - rightExpiry
  })
  return sorted[0] ?? null
}

export function mapGrokRedeemGrpcStatus(
  grpcStatus: string,
  grpcMessage: string | null
): CodexRateLimitResetOutcome {
  if (grpcStatus === '0') {
    return 'reset'
  }
  const message = (grpcMessage ?? '').toLowerCase()
  if (grpcStatus === '9') {
    return 'alreadyRedeemed'
  }
  if (grpcStatus === '3' && message.includes('token_id')) {
    return 'noCredit'
  }
  throw new Error(
    grpcMessage
      ? `Grok reset failed: ${grpcMessage}`
      : `Grok reset failed (grpc-status ${grpcStatus})`
  )
}

export async function consumeGrokRateLimitResetCreditFromRpc(
  session: GrokAuthSession,
  options: { signal?: AbortSignal; request?: GrokRpcRequest; tokenId?: string } = {}
): Promise<CodexRateLimitResetOutcome> {
  let tokenId = options.tokenId?.trim() ?? ''
  if (!tokenId) {
    const listed = await postGrokRpc(GROK_REMAINING_RESETS_URL, session, new Uint8Array(), {
      signal: options.signal,
      timeoutMs: FETCH_TIMEOUT_MS,
      request: options.request
    })
    if (listed.grpcStatus !== '0') {
      throw new Error(
        listed.grpcMessage
          ? `Grok remaining-resets failed: ${listed.grpcMessage}`
          : `Grok remaining-resets failed (grpc-status ${listed.grpcStatus})`
      )
    }
    tokenId = selectRedeemableToken(decodeRemainingResetTokens(listed.payload))?.tokenId ?? ''
  }
  if (!tokenId) {
    return 'noCredit'
  }
  const rpc = await postGrokRpc(GROK_REDEEM_RESET_URL, session, encodeRedeemResetRequest(tokenId), {
    signal: options.signal,
    timeoutMs: REDEEM_TIMEOUT_MS,
    request: options.request
  })
  return mapGrokRedeemGrpcStatus(rpc.grpcStatus, rpc.grpcMessage)
}
