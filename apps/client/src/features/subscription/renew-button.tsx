'use client';

// 续费按钮（「当前订阅」卡片右上角），点击弹确认框

import { useState, useTransition } from 'react';

import { Loader2Icon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@tillgate/ui';
import type { CurrentSubscription } from '@tillgate/api-client';

import { actionResult } from '@/features/shared/action-result';
import { formatDateTime } from '@/features/shared/format';
import { renewSubscriptionAction } from '@/server/actions/subscription';

import { InfoRow } from './info-row';
import { fmtYuan, planPeriodLabel } from './plan-format';

export function RenewButton({ sub }: { sub: CurrentSubscription }) {
  const t = useTranslations('subscription');
  const tUi = useTranslations('ui');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      const res = await renewSubscriptionAction(sub.id);
      if (!actionResult(res, t('renewFailed'), t('renewSuccessToast'))) return;
      setOpen(false);
    });
  }

  // 续费预览口径与服务端 renewalStart 一致：未到期从旧 endAt 顺延，已到期从 now 起算。
  // periodDays/endAt 异常缺失时兜底，绝不让 newEndAt 变 Invalid Date。
  const oldEndTs = new Date(sub.endAt).getTime();
  // eslint-disable-next-line react/purity -- 续费预览的 now 基准：渲染期求值即期望语义（预览到期日随渲染刷新），与渲染外时钟无一致性要求
  const baseTs = Number.isFinite(oldEndTs) ? Math.max(oldEndTs, Date.now()) : Date.now();
  const periodMs = Number.isFinite(sub.periodDays) ? sub.periodDays * 86_400_000 : 0;
  const newEndAt = new Date(baseTs + periodMs);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>{t('renew')}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('renewTitle')}</DialogTitle>
          <DialogDescription>{t('renewDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 rounded-lg border p-3 text-sm">
          <InfoRow label={t('labelPlan')}>
            {sub.planName}
            {sub.allowSeats ? ` ${t('seatsSuffix', { count: sub.quantity })}` : ''}
          </InfoRow>
          <InfoRow label={t('labelPeriod')}>{planPeriodLabel(sub.periodDays, t)}</InfoRow>
          <InfoRow label={t('labelCurrentEnd')}>{formatDateTime(sub.endAt, locale)}</InfoRow>
          <InfoRow label={t('labelNewEnd')}>
            {formatDateTime(newEndAt.toISOString(), locale)}
          </InfoRow>
          <InfoRow label={t('labelRenewAmount')} emphasize>
            {fmtYuan(sub.renewPrice, locale)}
          </InfoRow>
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>{tUi('cancel')}</DialogClose>
          <Button disabled={pending} onClick={confirm}>
            {pending && <Loader2Icon className="animate-spin" />}
            {t('confirmRenew')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
