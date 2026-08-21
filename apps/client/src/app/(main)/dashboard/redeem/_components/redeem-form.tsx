'use client';

import { useState } from 'react';

import { GiftIcon, Loader2Icon } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { z } from 'zod';

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
import { formatMoney } from '@ai-gateway/api-client/formatters';

import { redeemAction } from '../actions';

interface RedeemValues {
  code: string;
}

export function RedeemForm() {
  const t = useTranslations('redeem');
  const [result, setResult] = useState<{ amount: string; balanceAfter: string } | null>(null);

  const schema = z.object({
    code: z.string().min(4, t('invalidCode')),
  });

  const form = useForm<RedeemValues>({
    resolver: zodResolver(schema),
    defaultValues: { code: '' },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <GiftIcon className="size-5 text-primary" />
          {t('formTitle')}
        </CardTitle>
        <CardDescription>{t('formDesc')}</CardDescription>
      </CardHeader>
      <CardContent>
        {result ? (
          <div className="rounded-md bg-emerald-500/10 p-4 ring-1 ring-emerald-500/30">
            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
              {t('successNotice', { amount: formatMoney(result.amount) })}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('balanceAfter', { balance: formatMoney(result.balanceAfter) })}
              <button
                className="text-foreground underline"
                onClick={() => {
                  setResult(null);
                  form.reset();
                }}
              >
                {t('redeemAnother')}
              </button>
            </p>
          </div>
        ) : (
          <form
            onSubmit={form.handleSubmit(async (values) => {
              const res = await redeemAction(values.code);
              if (res.error) {
                // 文案单一真相 = 服务端注册表 message（错误码：REDEEM_INVALID_CODE 等）
                toast.error(t('failedToast'), { description: res.error });
                form.setError('code', { message: res.error });
                return;
              }
              setResult({ amount: res.amount!, balanceAfter: res.balanceAfter! });
              toast.success(t('creditedToast', { amount: formatMoney(res.amount!) }));
            })}
            className="space-y-3"
          >
            <FieldGroup>
              <Controller
                control={form.control}
                name="code"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="redeem-code">{t('codeLabel')}</FieldLabel>
                    <Input
                      id="redeem-code"
                      autoComplete="off"
                      placeholder={t('codePlaceholder')}
                      className="font-mono"
                      {...field}
                    />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
            </FieldGroup>
            <Button type="submit" disabled={form.formState.isSubmitting} className="w-full">
              {form.formState.isSubmitting && <Loader2Icon className="animate-spin" />}
              {t('submit')}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
