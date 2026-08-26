import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tillgate/ui';
import type { getTranslations } from 'next-intl/server';
import type { AdminUserRow } from '@tillgate/api-client';

import { UserActions } from '@/features/users/user-actions';
import { rateCardLabel, type RateCardOptionLike } from '@/features/users/rate-card-label';
import { fmtBalance, fmtDateTime } from '@/lib/formatters';

/** 用户资料卡（状态/余额/额度/限流字段平铺；从页面提出，规模与复杂度收敛） */
export function UserProfileCard({
  user,
  rateCards,
  t,
  tc,
}: {
  user: AdminUserRow;
  rateCards: ReadonlyArray<RateCardOptionLike>;
  t: Awaited<ReturnType<typeof getTranslations<'users'>>>;
  tc: Awaited<ReturnType<typeof getTranslations<'common'>>>;
}) {
  return (
    <Card className="w-full">
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-xl">
              {user.displayName ?? user.subject}{' '}
              <span className="text-base font-normal text-muted-foreground">#{user.id}</span>
            </CardTitle>
            <CardDescription className="space-x-2">
              <span>
                {tc('account')} {user.subject}
              </span>
              <span>·</span>
              <span>{user.email ?? t('noEmail')}</span>
              <span>·</span>
              <span>{user.identityProvider ?? '—'}</span>
            </CardDescription>
          </div>
          <UserActions user={user} />
        </div>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-4">
          <Field
            label={tc('status')}
            value={
              user.status === 0
                ? tc('active')
                : t('bannedReason', { reason: user.freezeReason ?? '' })
            }
          />
          <Field
            label={t('accountType')}
            value={user.isEnterprise ? t('enterprise') : t('personal')}
          />
          <Field label={t('settledBalanceLabel')} value={fmtBalance(user.balance)} />
          <Field label={t('reservedBalance')} value={fmtBalance(user.reservedBalance)} />
          <Field label={t('availableBalance')} value={fmtBalance(user.availableBalance)} />
          <Field label={tc('creditLimit')} value={fmtBalance(user.creditLimit)} />
          <Field
            label={tc('dailySpendLimit')}
            value={
              user.dailySpendLimit === null ? tc('unlimited') : fmtBalance(user.dailySpendLimit)
            }
          />
          <Field label={t('rateCard')} value={rateCardLabel(user, rateCards)} />
          <Field
            label={t('rpmLimit')}
            value={user.rpmLimit === null ? tc('default') : String(user.rpmLimit)}
          />
          <Field
            label={t('tpmLimit')}
            value={user.tpmLimit === null ? tc('default') : String(user.tpmLimit)}
          />
          <Field label="Issuer" value={user.issuer ?? '—'} />
          <Field label={tc('lastLogin')} value={fmtDateTime(user.lastLoginAt)} />
          <Field label={tc('createdAt')} value={fmtDateTime(user.createdAt)} />
        </dl>
      </CardContent>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
