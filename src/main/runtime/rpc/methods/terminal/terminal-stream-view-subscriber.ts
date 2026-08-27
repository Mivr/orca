import type { OrcaRuntimeService } from '../../../orca-runtime'

type RegisterTerminalStreamViewSubscriberOptions = {
  runtime: OrcaRuntimeService
  ptyId: string
  clientId: string | undefined
  isMobile: boolean
  queryReplyInput: 0 | 1 | undefined
}

export function registerTerminalStreamViewSubscriber({
  runtime,
  ptyId,
  clientId,
  isMobile,
  queryReplyInput
}: RegisterTerminalStreamViewSubscriberOptions): () => void {
  // Legacy mobile clients never claimed reply authority; keep main authoritative.
  if (queryReplyInput === 0 || (isMobile && (queryReplyInput !== 1 || clientId === undefined))) {
    return runtime.registerRawTerminalViewSubscriber(ptyId)
  }
  return runtime.registerRemoteTerminalViewSubscriber(ptyId, isMobile ? clientId : undefined)
}
