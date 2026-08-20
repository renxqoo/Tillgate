'use client';

import { useState, useTransition } from 'react';
import { Loader2Icon, MegaphoneIcon } from 'lucide-react';

import { Button } from '@ai-gateway/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ai-gateway/ui/components/ui/card';
import { Input } from '@ai-gateway/ui/components/ui/input';
import { useActionResult } from '@ai-gateway/ui/components/action-toast';

import { saveMarketingSettingsAction, type MarketingSettingsForm } from '../actions';

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

export function MarketingContent({ settings, error }: { settings: MarketingSettingsView | null; error: string | null }) {
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
        <CardContent className="p-6 text-sm text-muted-foreground">{error ?? '暂无配置'}</CardContent>
      </Card>
    );
  }

  const set = (key: keyof MarketingSettingsForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((cur) => (cur ? { ...cur, [key]: e.target.value } : cur));

  const save = () => {
    startTransition(async () => {
      try {
        await saveMarketingSettingsAction(form);
        notify({} as { error?: string }, '保存失败', '营销参数已保存（下一动作起生效，历史不重算）');
      } catch (e) {
        notify({ error: e instanceof Error ? e.message : '保存失败' });
      }
    });
  };

  const gifted = Number(form.signupGiftAmount) > 0;
  void settings;

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MegaphoneIcon className="size-4" /> 拉新资金参数
        </CardTitle>
        <CardDescription>
          改值即时生效：注册赠送/邀请奖励对下一次注册生效，佣金比例对下一轮日结生效；已入账部分按当时参数不重算。
          {settings?.updatedBy != null ? ` 最后修改：管理员 #${settings.updatedBy}（${new Date(settings.updatedAt).toLocaleString()}）` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2">
          <label className="text-sm font-medium" htmlFor="gift">注册赠送（元/人，0 = 关闭）</label>
          <Input id="gift" value={form.signupGiftAmount} onChange={set('signupGiftAmount')} inputMode="decimal" />
        </div>
        <div className="grid gap-2">
          <label className="text-sm font-medium" htmlFor="bonus">邀请注册奖励（元/人，双方各得，0 = 关闭）</label>
          <Input id="bonus" value={form.referralSignupBonus} onChange={set('referralSignupBonus')} inputMode="decimal" />
        </div>
        <div className="grid gap-2">
          <label className="text-sm font-medium" htmlFor="rate">邀请人佣金比例（被邀请人日消费 × 比例，0–1，0 = 关闭）</label>
          <Input id="rate" value={form.referralCommissionRate} onChange={set('referralCommissionRate')} inputMode="decimal" />
        </div>
        {gifted ? (
          <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            注册赠送已开启——请确认已配置 Turnstile 人机验证，否则存在批量刷号薅羊毛风险。
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Button onClick={save} disabled={pending}>
            {pending ? <Loader2Icon className="size-4 animate-spin" /> : null} 保存
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
