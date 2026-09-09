import { ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useResetCountdownClock } from '@/hooks/useResetCountdownClock'
import { formatResetCountdown } from '../../../../shared/rate-limit-reset-format'
import { useAppStore } from '../../store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { SearchableSetting } from './SearchableSetting'
import { formatPlanLabel } from '../status-bar/usage-roster-formatting'

const GOOGLE_AI_URL = 'https://one.google.com/explore-plan/gemini-advanced'

export function AntigravityAccountsSection(): React.JSX.Element {
  const refreshAntigravityRateLimits = useAppStore((s) => s.refreshAntigravityRateLimits)
  const antigravityUsage = useAppStore((s) => s.rateLimits.antigravity)
  const antigravityAuthConfigured = useAppStore((s) => s.rateLimits.antigravityAuthConfigured)
  const [refreshing, setRefreshing] = useState(false)

  const signedIn = antigravityAuthConfigured || antigravityUsage?.status === 'ok'
  const buckets = antigravityUsage?.buckets ?? []
  const email = antigravityUsage?.usageMetadata?.accountEmail ?? null
  const subscriptionStatus =
    antigravityUsage?.usageMetadata?.subscriptionStatus ?? antigravityUsage?.planType ?? null
  const planLabel = formatPlanLabel(subscriptionStatus)
  const now = useResetCountdownClock(buckets.map((bucket) => bucket.resetsAt))

  const handleRefreshUsage = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshAntigravityRateLimits()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <section id="accounts-antigravity" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <AgentIcon agent="antigravity" size={16} />
            {translate(
              'auto.components.settings.AntigravityAccountsSection.title',
              'Antigravity / Google AI'
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.AntigravityAccountsSection.description',
              'Shows Google AI subscription quota (Gemini 7d/5h, Frontier 7d/5h) from agy login or Fleet usage override.'
            )}
          </p>
        </div>
        <a
          href={GOOGLE_AI_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate(
            'auto.components.settings.AntigravityAccountsSection.docs',
            'Google AI subscription'
          )}
          <ExternalLink className="size-3" />
        </a>
      </div>

      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border bg-muted/20 p-3',
          signedIn ? 'border-border/60' : 'border-border/40'
        )}
      >
        <ShieldCheck
          className={cn(
            'mt-0.5 size-4 shrink-0',
            signedIn ? 'text-foreground' : 'text-muted-foreground'
          )}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">
            {signedIn
              ? translate(
                  'auto.components.settings.AntigravityAccountsSection.signedIn',
                  'Connected'
                )
              : translate(
                  'auto.components.settings.AntigravityAccountsSection.signedOut',
                  'Not connected — sign in with agy login on this computer'
                )}
          </p>
          {email ? (
            <p className="truncate text-xs text-foreground font-medium">{email}</p>
          ) : null}
          {planLabel || subscriptionStatus ? (
            <p className="text-xs text-muted-foreground">
              {[planLabel, subscriptionStatus].filter(Boolean).join(' · ')}
            </p>
          ) : null}
          {antigravityUsage?.error ? (
            <p className="text-xs text-muted-foreground">{antigravityUsage.error}</p>
          ) : null}
        </div>
        <Button
          variant="outline"
          size="xs"
          disabled={refreshing}
          onClick={() => void handleRefreshUsage()}
          className="shrink-0 gap-1"
        >
          {refreshing ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          {translate(
            'auto.components.settings.AntigravityAccountsSection.refresh',
            'Refresh usage'
          )}
        </Button>
      </div>

      {buckets.map((item) => (
        <SearchableSetting
          key={item.name}
          title={item.name}
          description={translate(
            'auto.components.settings.AntigravityAccountsSection.bucketDescription',
            'Live percentage used for this Google AI quota window.'
          )}
          keywords={['antigravity', 'google ai', 'gemini', 'frontier', 'usage', 'rate limit', item.name.toLowerCase()]}
        >
          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium text-foreground min-w-[100px]">{item.name}</span>
            <Badge variant="secondary" className="tabular-nums">
              {Math.round(item.usedPercent)}%
            </Badge>
            {item.resetDescription || item.resetsAt ? (
              <span className="text-muted-foreground">
                {item.resetDescription
                  ? translate(
                      'auto.components.settings.AntigravityAccountsSection.resetsOn',
                      'Resets {{when}}',
                      { when: item.resetDescription }
                    )
                  : null}
                {item.resetsAt
                  ? `${item.resetDescription ? ' · ' : ''}${formatResetCountdown(item.resetsAt - now)}`
                  : null}
              </span>
            ) : null}
          </div>
        </SearchableSetting>
      ))}
    </section>
  )
}
