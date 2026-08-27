import { Loader2, RotateCcw } from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'
import { ProviderDetailsMenu } from './ProviderDetailsMenu'
import { formatResetCreditExpiry } from './tooltip'

export function GrokResetMenu({
  grok,
  compact,
  iconOnly,
  asSubmenu = false,
  triggerContent
}: {
  grok: ProviderRateLimits
  compact: boolean
  iconOnly: boolean
  asSubmenu?: boolean
  triggerContent?: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [skipFutureResetConfirm, setSkipFutureResetConfirm] = useState(false)
  const [isRedeemingReset, setIsRedeemingReset] = useState(false)
  const mountedRef = useRef(true)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const consumeGrokRateLimitResetCredit = useAppStore((s) => s.consumeGrokRateLimitResetCredit)
  const settings = useAppStore((s) => s.settings)
  const hasActiveRuntimeEnvironment = Boolean(settings?.activeRuntimeEnvironmentId?.trim())
  const resetCreditCount = grok.rateLimitResetCredits?.availableCount ?? null
  const resetCreditExpiry =
    resetCreditCount !== null
      ? formatResetCreditExpiry(grok.rateLimitResetCredits?.nextExpiresAt, resetCreditCount)
      : null
  // Why: desktop redeem talks to this machine's Grok CLI login, not a remote host's.
  const canRedeemReset =
    !hasActiveRuntimeEnvironment && resetCreditCount !== null && resetCreditCount > 0

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const handleRedeemReset = async (): Promise<void> => {
    if (isRedeemingReset) {
      return
    }
    setIsRedeemingReset(true)
    try {
      await consumeGrokRateLimitResetCredit()
    } catch (error) {
      console.error('Failed to redeem Grok usage-limit reset from status bar:', error)
    } finally {
      if (mountedRef.current) {
        setIsRedeemingReset(false)
      }
    }
  }

  const handleResetMenuSelect = (): void => {
    if (settings?.skipGrokRateLimitResetConfirm) {
      void handleRedeemReset()
      return
    }
    setSkipFutureResetConfirm(false)
    setResetConfirmOpen(true)
  }

  const handleConfirmReset = async (): Promise<void> => {
    if (isRedeemingReset) {
      return
    }
    if (skipFutureResetConfirm) {
      try {
        await updateSettings({ skipGrokRateLimitResetConfirm: true })
      } catch (error) {
        console.error('Failed to save Grok reset confirmation preference:', error)
      }
    }
    await handleRedeemReset()
    if (mountedRef.current) {
      setResetConfirmOpen(false)
      setSkipFutureResetConfirm(false)
    }
  }

  return (
    <ProviderDetailsMenu
      provider={grok}
      compact={compact}
      iconOnly={iconOnly}
      asSubmenu={asSubmenu}
      triggerContent={triggerContent}
      hidePanelResetCredits
      ariaLabel={translate(
        'auto.components.status.bar.StatusBar.grokResetMenuAria',
        'Open Grok details and usage-limit reset'
      )}
      open={open}
      onOpenChange={setOpen}
    >
      <Dialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <DialogContent className="sm:max-w-[420px]" {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}>
          <DialogHeader>
            <DialogTitle>
              {translate(
                'auto.components.status.bar.StatusBar.grokResetConfirmTitle',
                'Reset Grok limits?'
              )}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.status.bar.StatusBar.grokResetConfirmBody',
                'This uses one SuperGrok usage-limit reset token for the signed-in account and clears the current weekly pool immediately.'
              )}
            </DialogDescription>
          </DialogHeader>
          <label className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-xs text-foreground/80 transition-colors hover:text-foreground">
            <Checkbox
              checked={skipFutureResetConfirm}
              onCheckedChange={(checked) => setSkipFutureResetConfirm(checked === true)}
            />
            <span>
              {translate('auto.components.status.bar.StatusBar.f077f586db', "Don't ask again")}
            </span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetConfirmOpen(false)}>
              {translate('auto.components.status.bar.StatusBar.c0e972d726', 'Cancel')}
            </Button>
            <Button onClick={() => void handleConfirmReset()} disabled={isRedeemingReset}>
              {isRedeemingReset ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCcw className="size-4" />
              )}
              {isRedeemingReset
                ? translate('auto.components.status.bar.StatusBar.25d8bbde69', 'Using reset…')
                : translate('auto.components.status.bar.StatusBar.e159fc1fd7', 'Reset now')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {resetCreditCount !== null ? (
        <>
          <DropdownMenuLabel className="space-y-0.5">
            <div>
              {resetCreditCount === 1
                ? translate(
                    'auto.components.status.bar.StatusBar.5e5f9f5160',
                    '1 rate-limit reset available'
                  )
                : translate(
                    'auto.components.status.bar.StatusBar.5ecae9197c',
                    '{{value0}} rate-limit resets available',
                    { value0: resetCreditCount }
                  )}
            </div>
            {resetCreditExpiry ? (
              <div className="text-[11px] font-normal text-muted-foreground">
                {resetCreditExpiry}
              </div>
            ) : null}
          </DropdownMenuLabel>
          {canRedeemReset ? (
            <DropdownMenuItem
              disabled={isRedeemingReset}
              onSelect={(event) => {
                event.preventDefault()
                handleResetMenuSelect()
              }}
            >
              {isRedeemingReset ? (
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              ) : null}
              {isRedeemingReset
                ? translate('auto.components.status.bar.StatusBar.25d8bbde69', 'Using reset…')
                : translate('auto.components.status.bar.StatusBar.e159fc1fd7', 'Reset now')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
        </>
      ) : null}
      <DropdownMenuItem
        onSelect={() => {
          openSettingsTarget({
            pane: 'accounts',
            repoId: null,
            sectionId: 'accounts-grok'
          })
          openSettingsPage()
        }}
      >
        {translate('auto.components.status.bar.StatusBar.75ded02687', 'Manage Accounts…')}
      </DropdownMenuItem>
    </ProviderDetailsMenu>
  )
}
