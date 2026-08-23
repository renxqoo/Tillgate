import { SettingsIcon, ShieldCheckIcon } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@tokenlens/ui';

import { DisplayNameDialog } from '@/features/settings/display-name-dialog';
import { PasswordDialog } from '@/features/settings/password-dialog';
import { formatDateTime, formatMoney } from '@/features/shared/format';
import { createClientApi } from '@/server/api';
import { requireMe } from '@/server/session';

export const dynamic = 'force-dynamic';

function InfoRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-2.5 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium break-all text-right">{value}</span>
    </div>
  );
}

export default async function SettingsPage() {
  const api = createClientApi();
  const me = await requireMe(api);
  const t = await getTranslations('settings');
  const tCommon = await getTranslations('common');
  const locale = await getLocale();
  const balance = me.accounts.find((account) => account.currency === 'CNY')?.balance ?? '0';

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <SettingsIcon className="size-5 text-muted-foreground" />
          {t('title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="text-base">{t('infoTitle')}</CardTitle>
          <CardDescription>{t('infoDesc')}</CardDescription>
          <CardAction>
            <DisplayNameDialog current={me.displayName || me.subject} />
          </CardAction>
        </CardHeader>
        <CardContent>
          <InfoRow label={t('displayName')} value={me.displayName || me.subject} />
          <InfoRow label={tCommon('email')} value={me.email ?? '—'} />
          <InfoRow label={t('balanceLabel')} value={formatMoney(balance, locale)} />
          <InfoRow label={t('rateCardLabel')} value={me.rateCardName ?? '—'} />
          <InfoRow
            label={t('accountTypeLabel')}
            value={me.isEnterprise ? t('enterprise') : t('personal')}
          />
          <InfoRow
            label={t('rateLimitLabel')}
            value={
              me.rpmLimit == null || me.tpmLimit == null
                ? '—'
                : t('rateLimitValue', {
                    rpm: me.rpmLimit.toLocaleString('en-US'),
                    tpm: (me.tpmLimit / 10000).toLocaleString('en-US', {
                      maximumFractionDigits: 1,
                    }),
                  })
            }
          />
          <InfoRow label={t('lastLogin')} value={formatDateTime(me.lastLoginAt, locale)} />
          <InfoRow label={t('registeredAt')} value={formatDateTime(me.createdAt, locale)} />
        </CardContent>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheckIcon className="size-4 text-muted-foreground" />
            {t('securityTitle')}
          </CardTitle>
          <CardDescription>{t('securityDesc')}</CardDescription>
          <CardAction>
            <PasswordDialog />
          </CardAction>
        </CardHeader>
      </Card>
    </div>
  );
}
