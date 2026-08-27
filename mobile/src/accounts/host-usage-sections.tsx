import { Text, View } from 'react-native'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import {
  type AccountsSnapshot,
  getBucketResetLabel,
  getBucketUsageBarState,
  getHostProviderRateLimits,
  getUsageBarState,
  getWindowResetLabel,
  hasActiveProviderUsage,
  UsageBar
} from '../components/AccountUsage'
import { getGrokResetCreditSummary } from '../components/grok-reset-credit'
import { CodexResetCreditAction } from '../components/CodexResetCreditAction'
import { useGrokResetCreditAction } from '../components/use-grok-reset-credit-action'
import type { RpcClient } from '../transport/rpc-client'
import { styles } from './mobile-accounts-screen-styles'

export function HostUsageSections({
  snapshot,
  now,
  connected,
  busy,
  resettingCodex,
  client,
  hostId,
  onSnapshot
}: {
  snapshot: AccountsSnapshot
  now: number
  connected: boolean
  busy: boolean
  resettingCodex: boolean
  client: RpcClient | null
  hostId: string | undefined
  onSnapshot: (snapshot: AccountsSnapshot) => void
}): React.JSX.Element {
  const { supported, resetting, confirmReset } = useGrokResetCreditAction({
    client,
    connected,
    hostId,
    snapshot,
    accountMutationBusy: busy,
    onSnapshot
  })
  return (
    <>
      <GrokHostSection
        snapshot={snapshot}
        now={now}
        connected={connected}
        busy={busy}
        grokResetSupported={supported}
        resettingGrok={resetting}
        resettingCodex={resettingCodex}
        onConfirmGrokReset={confirmReset}
      />
      <CursorHostSection snapshot={snapshot} now={now} />
    </>
  )
}

function GrokHostSection({
  snapshot,
  now,
  connected,
  busy,
  grokResetSupported,
  resettingGrok,
  resettingCodex,
  onConfirmGrokReset
}: {
  snapshot: AccountsSnapshot
  now: number
  connected: boolean
  busy: boolean
  grokResetSupported: boolean
  resettingGrok: boolean
  resettingCodex: boolean
  onConfirmGrokReset: () => void
}): React.JSX.Element | null {
  const usage = getHostProviderRateLimits(snapshot, 'grok')
  if (!hasActiveProviderUsage(usage)) {
    return null
  }
  const weeklyBar = getUsageBarState(usage, 'weekly')
  const resetCredit = getGrokResetCreditSummary(usage, now)
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <MobileAgentIcon agentId="grok" size={14} />
        <Text style={styles.sectionHeading}>Grok</Text>
      </View>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle}>Host CLI login</Text>
            {usage?.usageMetadata?.authProvenance ? (
              <Text style={styles.rowSubtitle} numberOfLines={1}>
                {usage.usageMetadata.authProvenance}
              </Text>
            ) : (
              <Text style={styles.rowSubtitle}>Uses grok login on the host</Text>
            )}
            <View style={styles.usageRow}>
              <UsageBar
                label="7d"
                usedPercent={weeklyBar.usedPercent}
                unavailable={weeklyBar.unavailable}
                loading={weeklyBar.loading}
                resetText={getWindowResetLabel(usage, 'weekly', now)}
              />
            </View>
          </View>
        </View>
        {resetCredit && grokResetSupported && connected ? (
          <CodexResetCreditAction
            summary={resetCredit}
            productLabel="Grok"
            scopeLabel="the host Grok login"
            busy={resettingGrok}
            disabled={resettingGrok || resettingCodex || busy || !connected}
            onPress={onConfirmGrokReset}
          />
        ) : null}
      </View>
    </View>
  )
}

function CursorHostSection({
  snapshot,
  now
}: {
  snapshot: AccountsSnapshot
  now: number
}): React.JSX.Element | null {
  const usage = getHostProviderRateLimits(snapshot, 'cursor')
  if (!hasActiveProviderUsage(usage) && !usage?.buckets?.length) {
    return null
  }
  const email = usage?.usageMetadata?.accountEmail ?? null
  const subscriptionStatus = usage?.usageMetadata?.subscriptionStatus ?? null
  const planLabel = usage?.planType ?? null
  const buckets = usage?.buckets ?? []
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <MobileAgentIcon agentId="cursor" size={14} />
        <Text style={styles.sectionHeading}>Cursor</Text>
      </View>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {email ?? 'Host Cursor login'}
            </Text>
            {planLabel || subscriptionStatus ? (
              <Text style={styles.rowSubtitle} numberOfLines={1}>
                {[planLabel, subscriptionStatus].filter(Boolean).join(' · ')}
              </Text>
            ) : (
              <Text style={styles.rowSubtitle}>Uses Cursor on the host</Text>
            )}
            {buckets.map((bucket) => {
              const bar = getBucketUsageBarState(usage, bucket.name)
              return (
                <View key={bucket.name} style={styles.usageRow}>
                  <UsageBar
                    label={bucket.name}
                    labelWidth={92}
                    usedPercent={bar.usedPercent}
                    unavailable={bar.unavailable}
                    loading={bar.loading}
                    resetText={
                      bucket.resetDescription
                        ? `Resets ${bucket.resetDescription}`
                        : getBucketResetLabel(usage, bucket.name, now)
                    }
                  />
                </View>
              )
            })}
          </View>
        </View>
      </View>
    </View>
  )
}
