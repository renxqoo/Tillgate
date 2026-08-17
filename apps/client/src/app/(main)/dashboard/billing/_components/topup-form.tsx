'use client';

import { useState } from 'react';

import { Loader2Icon, WalletIcon } from 'lucide-react';
import { toast } from 'sonner';

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

export function TopUpForm({ channels }: { channels: Array<{ id: 'epay' | 'stripe'; label: string }> }) {
  const [amount, setAmount] = useState('50');
  const [provider, setProvider] = useState<'epay' | 'stripe' | ''>('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!provider) {
      setError('请选择支付渠道');
      return;
    }
    const value = Number(amount);
    if (!Number.isFinite(value) || value < 1 || value > 100000) {
      setError('金额须在 1~100000 元之间');
      return;
    }
    setPending(true);
    const res = await createPaymentAction(provider, value.toFixed(2));
    setPending(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    if (res.payUrl) {
      toast.success('订单已创建，正在跳转支付…');
      window.location.href = res.payUrl;
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <WalletIcon className="size-5 text-primary" />
          在线充值
        </CardTitle>
        <CardDescription>支付成功后余额实时到账（回调自动入账）</CardDescription>
      </CardHeader>
      <CardContent>
        {channels.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            在线支付渠道暂未开放，请使用<a className="underline" href="/dashboard/redeem">充值码</a>充值。
          </p>
        ) : (
          <FieldGroup>
            <Field>
              <FieldLabel>充值金额（元，1:1 到账）</FieldLabel>
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
                placeholder="自定义金额"
              />
            </Field>
            <Field>
              <FieldLabel>支付渠道</FieldLabel>
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
              立即充值
            </Button>
          </FieldGroup>
        )}
      </CardContent>
    </Card>
  );
}
