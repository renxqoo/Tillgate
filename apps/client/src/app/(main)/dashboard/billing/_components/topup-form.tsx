'use client';

import { useState } from 'react';

import { Loader2Icon, WalletIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@ai-gateway/ui/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@ai-gateway/ui/components/ui/card';
import { Field, FieldError, FieldGroup, FieldLabel } from '@ai-gateway/ui/components/ui/field';
import { Input } from '@ai-gateway/ui/components/ui/input';

import { createPaymentAction } from '../actions';

const PRESETS = ['10', '50', '100', '500'];

function validTopupAmount(raw: string): boolean {
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(raw)) return false;
  const [yuan = '0', fraction = ''] = raw.split('.');
  const cents = BigInt(yuan) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents >= 100n && cents <= 10_000_000n;
}

export function TopUpForm({ channels }: { channels: Array<{ id: 'epay' | 'stripe'; label: string }> }) {
  const t = useTranslations('billing');
  const [amount, setAmount] = useState('50');
  const [provider, setProvider] = useState<'epay' | 'stripe' | ''>('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!provider) {
      setError(t('selectChannel'));
      return;
    }
    if (!validTopupAmount(amount)) {
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
                <a className="underline" href="/dashboard/redeem">{chunks}</a>
              ),
            })}
          </p>
        ) : (
          <FieldGroup>
            <Field>
              <FieldLabel>{t('amountLabel')}</FieldLabel>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((p) => (
                  <Button
                    key={p}
                    type="button"
                    variant={amount === p ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setAmount(p)}
                  >
                    ¥{p}
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
