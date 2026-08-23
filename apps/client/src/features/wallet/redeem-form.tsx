'use client';

import { useState } from 'react';

import { GiftIcon, Loader2Icon } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useLocale, useTranslations } from 'next-intl';
import { z } from 'zod';

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
} from '@tokenlens/ui';

import { formatMoney } from '@/features/shared/format';
import { redeemAction } from '@/server/actions/redeem';

interface RedeemValues {
  code: string;
}

export function RedeemForm() {
  const t = useTranslations('redeem');
  const locale = useLocale();
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
              {t('successNotice', { amount: formatMoney(result.amount, locale) })}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('balanceAfter', { balance: formatMoney(result.balanceAfter, locale) })}
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
                // 文案单一真相 = 后端错误目录 message（按 accept-language 本地化）
                toast.error(t('failedToast'), { description: res.error });
                form.setError('code', { message: res.error });
                return;
              }
              setResult({ amount: res.amount!, balanceAfter: res.balanceAfter! });
              toast.success(t('creditedToast', { amount: formatMoney(res.amount!, locale) }));
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
