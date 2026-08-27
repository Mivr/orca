import { ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { SearchableSetting } from './SearchableSetting'
import { formatPlanLabel } from '../status-bar/usage-roster-formatting'
import { formatResetCountdown } from '../../../../shared/rate-limit-reset-format'
import { useResetCountdownClock } from '@/hooks/useResetCountdownClock'
import { useState } from 'react'

const CURSOR_SPENDING_URL = 'https://cursor.com/dashboard/spending'
const CURSOR_CLI_DOCS_URL = 'https://cursor.com/docs/cli/overview'

export function CursorAccountsSection(): React.JSX.Element {
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const cursorUsage = useAppStore((s) => s.rateLimits.cursor)
  const cursorAuthConfigured = useAppStore((s) => s.rateLimits.cursorAuthConfigured)
  const [refreshing, setRefreshing] = useState(false)

  const signedIn = cursorAuthConfigured || cursorUsage?.status === 'ok'
  const buckets = cursorUsage?.buckets ?? []
  const email = cursorUsage?.usageMetadata?.accountEmail ?? null
  const subscriptionStatus = cursorUsage?.usageMetadata?.subscriptionStatus ?? null
  const planLabel = formatPlanLabel(cursorUsage?.planType)
  const now = useResetCountdownClock(buckets.map((bucket) => bucket.resetsAt))

  const handleRefreshUsage = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshRateLimits()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <section id="accounts-cursor" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <AgentIcon agent="cursor" size={16} />
            {translate('auto.components.settings.CursorAccountsSection.title', 'Cursor')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.CursorAccountsSection.description',
              'Shows Cursor Models, Other Models, and Grok Bot usage from the Cursor desktop or cursor-agent login on this machine. Orca does not refresh that session.'
            )}
          </p>
        </div>
        <a
          href={CURSOR_CLI_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate('auto.components.settings.CursorAccountsSection.docs', 'Cursor CLI docs')}
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
              ? translate('auto.components.settings.CursorAccountsSection.signedIn', 'Signed in')
              : translate(
                  'auto.components.settings.CursorAccountsSection.signedOut',
                  'Not signed in — run Cursor or cursor-agent login on this computer'
                )}
          </p>
          {email ? (
            <a
              href={CURSOR_SPENDING_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 truncate text-xs text-foreground hover:underline"
            >
              {email}
              <ExternalLink className="size-3 shrink-0" />
            </a>
          ) : null}
          {planLabel || subscriptionStatus ? (
            <p className="text-xs text-muted-foreground">
              {[planLabel, subscriptionStatus].filter(Boolean).join(' · ')}
            </p>
          ) : null}
          {cursorUsage?.error ? (
            <p className="text-xs text-muted-foreground">{cursorUsage.error}</p>
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
          {translate('auto.components.settings.CursorAccountsSection.refresh', 'Refresh usage')}
        </Button>
      </div>

      {buckets.map((item) => (
        <SearchableSetting
          key={item.name}
          title={item.name}
          description={translate(
            'auto.components.settings.CursorAccountsSection.bucketDescription',
            'Live percent used for this Cursor pool. Caps are not hardcoded.'
          )}
          keywords={['cursor', 'usage', 'rate limit', item.name.toLowerCase()]}
        >
          <div className="flex items-center gap-2 text-xs">
            <Badge variant="secondary" className="tabular-nums">
              {Math.round(item.usedPercent)}%
            </Badge>
            {item.resetDescription || item.resetsAt ? (
              <span className="text-muted-foreground">
                {item.resetDescription
                  ? translate(
                      'auto.components.settings.CursorAccountsSection.resetsOn',
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
