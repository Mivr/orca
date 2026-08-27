import { isTerminalQueryReply } from '../../../src/shared/terminal-query-reply'
import type { RpcClient } from '../transport/rpc-client'
import { isTerminalSendRpcAccepted } from './terminal-send-rpc-response'

type TerminalQueryReplyAuthorityRegistry = {
  has: (handle: string) => boolean
}

type MobileTerminalQueryReplyOptions = {
  bytes: string
  client: Pick<RpcClient, 'sendRequest'> | null
  clientId: string | null
  connected: boolean
  handle: string
  hostSupportsQueryReplyInput: boolean
  queryReplyAuthorityTerminals: TerminalQueryReplyAuthorityRegistry
}

export function sendMobileTerminalQueryReply({
  bytes,
  client,
  clientId,
  connected,
  handle,
  hostSupportsQueryReplyInput,
  queryReplyAuthorityTerminals
}: MobileTerminalQueryReplyOptions): Promise<boolean> {
  // Why: only a subscription that claimed query authority suppresses main.
  // Hosts without terminal.query-reply-input.v1 strip inputKind and would take
  // reply bytes as floor-stealing shell input, so drop (pre-fix behavior).
  if (
    !client ||
    !connected ||
    !hostSupportsQueryReplyInput ||
    !queryReplyAuthorityTerminals.has(handle) ||
    !isTerminalQueryReply(bytes)
  ) {
    return Promise.resolve(false)
  }

  return client
    .sendRequest('terminal.send', {
      terminal: handle,
      text: bytes,
      enter: false,
      inputKind: 'query-reply',
      ...(clientId ? { client: { id: clientId, type: 'mobile' as const } } : {})
    })
    .then(isTerminalSendRpcAccepted, () => false)
}
