import { useEffect, useState } from 'react'
import { GROK_RESET_CREDIT_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { RpcClient } from '../transport/rpc-client'
import { startRuntimeCapabilityProbe } from '../transport/runtime-capability-probe'

export const MOBILE_GROK_RESET_CREDIT_CAPABILITY = GROK_RESET_CREDIT_RUNTIME_CAPABILITY

export function useGrokResetCreditCapability(
  client: RpcClient | null,
  connected: boolean
): boolean {
  const [supported, setSupported] = useState(false)

  useEffect(() => {
    setSupported(false)
    if (!client || !connected) {
      return
    }
    return startRuntimeCapabilityProbe(client, (capabilities) => {
      setSupported(capabilities.includes(MOBILE_GROK_RESET_CREDIT_CAPABILITY))
    })
  }, [client, connected])

  return supported
}
