'use client';

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  FieldLabel,
  FormItem,
  Input,
} from '@tillgate/ui';
import { useState, useTransition } from 'react';
import { Loader2Icon, MegaphoneIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useActionResult } from '@/components/action-toast';

import {
  saveMarketingSettingsAction,
  type MarketingSettingsForm,
} from '@/server/marketing-actions';

export interface MarketingSettingsView {
  signupGiftAmount: string;
  referralSignupBonus: string;
  referralCommissionRate: string;
  updatedBy: number | null;
  updatedAt: string | Date;
}

/** 金额/比例展示为去尾零的简短形态 */
function trimNumeric(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : value;
}

export function MarketingContent({
  settings,
  error,
}: {
  settings: MarketingSettingsView | null;
  error: string | null;
}) {
  const t = useTranslations('marketing');
  const tc = useTranslations('common');
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();
  const [form, setForm] = useState<MarketingSettingsForm | null>(
    settings
      ? {
          signupGiftAmount: trimNumeric(settings.signupGiftAmount),
          referralSignupBonus: trimNumeric(settings.referralSignupBonus),
          referralCommissionRate: trimNumeric(settings.referralCommissionRate),
        }
      : null,
  );

  if (error || !form) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          {error ?? t('noSettings')}
        </CardContent>
      </Card>
    );
  }

  const set = (key: keyof MarketingSettingsForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((cur) => (cur ? { ...cur, [key]: e.target.value } : cur));

  const save = () => {
    startTransition(async () => {
      try {
        await saveMarketingSettingsAction(form);
        notify({} as { error?: string }, tc('saveFailed'), t('saved'));
      } catch (e) {
        notify({ error: e instanceof Error ? e.message : tc('saveFailed') });
      }
    });
  };

  const gifted = Number(form.signupGiftAmount) > 0;
  void settings;

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MegaphoneIcon className="size-4" /> {t('formTitle')}
        </CardTitle>
        <CardDescription>
          {t('formDescription')}
          {settings?.updatedBy != null
            ? t('lastModified', {
                id: settings.updatedBy,
                date: new Date(settings.updatedAt).toLocaleString('en-US'),
              })
            : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <FormItem>
          <FieldLabel htmlFor="gift">{t('signupGift')}</FieldLabel>
          <Input
            id="gift"
            value={form.signupGiftAmount}
            onChange={set('signupGiftAmount')}
            inputMode="decimal"
          />
        </FormItem>
        <FormItem>
          <FieldLabel htmlFor="bonus">{t('referralBonus')}</FieldLabel>
          <Input
            id="bonus"
            value={form.referralSignupBonus}
            onChange={set('referralSignupBonus')}
            inputMode="decimal"
          />
        </FormItem>
        <FormItem>
          <FieldLabel htmlFor="rate">{t('commissionRate')}</FieldLabel>
          <Input
            id="rate"
            value={form.referralCommissionRate}
            onChange={set('referralCommissionRate')}
            inputMode="decimal"
          />
        </FormItem>
        {gifted ? (
          <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            {t('giftWarning')}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Button onClick={save} disabled={pending}>
            {pending ? <Loader2Icon className="size-4 animate-spin" /> : null} {tc('save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
