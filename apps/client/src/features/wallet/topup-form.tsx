'use client';

import { useState } from 'react';

import { Loader2Icon, WalletIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  toast,
} from '@tillgate/ui';

import { formatMoney } from '@/features/shared/format';
import { TOPUP_PRESETS, isValidTopupAmount } from '@/features/wallet/topup-schema';
import { createPaymentAction } from '@/server/actions/billing';

export function TopUpForm({
  channels,
}: {
  /** 渠道目录（wire id 为 string；实际词表 epay/stripe 由下单契约再校验） */
  channels: Array<{ id: string; label: string }>;
}) {
  const t = useTranslations('billing');
  const locale = useLocale();
  const [amount, setAmount] = useState('50');
  const [provider, setProvider] = useState<string>('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (provider !== 'epay' && provider !== 'stripe') {
      setError(t('selectChannel'));
      return;
    }
    if (!isValidTopupAmount(amount)) {
      setError(t('amountRange'));
      return;
    }
    setPending(true);
    const res = await createPaymentAction(provider, amount);
    setPending(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    if (res.payUrl) {
      toast.success(t('orderCreated'));
      window.location.href = res.payUrl;
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <WalletIcon className="size-5 text-primary" />
          {t('topupTitle')}
        </CardTitle>
        <CardDescription>{t('topupDesc')}</CardDescription>
      </CardHeader>
      <CardContent>
        {channels.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t.rich('channelsEmpty', {
              link: (chunks) => (
                <a className="underline" href="/dashboard/redeem">
                  {chunks}
                </a>
              ),
            })}
          </p>
        ) : (
          <FieldGroup>
            <Field>
              <FieldLabel>{t('amountLabel')}</FieldLabel>
              <div className="flex flex-wrap gap-2">
                {TOPUP_PRESETS.map((p) => (
                  <Button
                    key={p}
                    type="button"
                    variant={amount === p ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setAmount(p)}
                  >
                    {formatMoney(p, locale)}
                  </Button>
                ))}
              </div>
              <Input
                className="mt-2 max-w-48"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
                placeholder={t('customAmount')}
              />
            </Field>
            <Field>
              <FieldLabel>{t('channelLabel')}</FieldLabel>
              <div className="flex flex-wrap gap-2">
                {channels.map((ch) => (
                  <Button
                    key={ch.id}
                    type="button"
                    variant={provider === ch.id ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setProvider(ch.id)}
                  >
                    {ch.label}
                  </Button>
                ))}
              </div>
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <Button onClick={submit} disabled={pending}>
              {pending ? <Loader2Icon className="size-4 animate-spin" /> : null}
              {t('submit')}
            </Button>
          </FieldGroup>
        )}
      </CardContent>
    </Card>
  );
}
