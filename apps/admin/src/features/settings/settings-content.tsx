'use client';

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tokenlens/ui';
import { useState, useTransition } from 'react';

import { Loader2Icon, ShieldCheckIcon, SmartphoneIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { AdminMeInfo } from '@tokenlens/api-client';

import { setTwoFactorAction } from '@/server/auth-actions';
import { useActionResult } from '@/components/action-toast';
import { BillingTimezoneCard } from './billing-timezone-card';
import { TotpCard } from './totp-card';

export function SettingsContent({ me, error }: { me: AdminMeInfo | null; error: string | null }) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();
  const [enabled, setEnabled] = useState(Boolean(me?.twoFactorEnabled));

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">{error}</CardContent>
      </Card>
    );
  }

  return (
    <div className='flex flex-row gap-4'>
      <div className="flex max-w-xl flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheckIcon className="size-4" /> {t('twoFactor')}
            </CardTitle>
            <CardDescription>
              {t('twoFactorDescription', { email: me?.email ?? '—' })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-3">
              <Button
                variant={enabled ? 'destructive' : 'default'}
                size="sm"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const next = !enabled;
                    const res = await setTwoFactorAction(next);
                    if (
                      notify(
                        res ?? {},
                        tc('actionFailed'),
                        next ? t('enabledToast') : t('disabledToast'),
                      )
                    )
                      setEnabled(next);
                  })
                }
              >
                {pending && <Loader2Icon className="animate-spin" />}
                {enabled ? t('disable') : t('enable')}
              </Button>
              <span className="text-sm text-muted-foreground">
                {t('currentStatus')}
                <span className={enabled ? 'text-green-600' : ''}>
                  {enabled ? t('enabledState') : t('disabledState')}
                </span>
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{t('smtpHint')}</p>
          </CardContent>
        </Card>

    
      </div>
    
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <SmartphoneIcon className="size-4" /> {t('totp.title')}
          </CardTitle>
          <CardDescription>
            {me?.totpEnabled ? t('totp.boundDescription') : t('totp.bindDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TotpCard totpEnabled={me?.totpEnabled ?? false} />
        </CardContent>
      </Card>

      <BillingTimezoneCard />
    </div>
  );
}
