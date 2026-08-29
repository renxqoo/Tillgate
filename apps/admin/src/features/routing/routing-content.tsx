'use client';

/**
 * 智能路由管理编排：策略表单（评分器/韧性两卡）保存（热生效 ≤15s）；
 * 渠道观测表为哑件。表单状态集中在编排器。
 */
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button, Input } from '@tillgate/ui';
import { saveRoutingPolicyAction } from '@/server/routing-actions';
import { buildPolicy, formOf, validateForm } from './routing-policy-form';
import { ChannelOverviewTable } from './overview-table';
import { PolicyFormCards } from './policy-form-cards';
import type { ChannelOverviewView, PolicyForm, RoutingPolicyView } from './routing-content-types';

export type { RoutingPolicyView } from './routing-content-types';

export function RoutingClient({
  current,
  fallback,
  overview,
}: {
  current: RoutingPolicyView | null;
  fallback: Record<string, unknown>;
  overview: ChannelOverviewView[];
}) {
  const t = useTranslations('routing');
  const [form, setForm] = useState<PolicyForm>(formOf(current?.policy ?? fallback));
  const [note, setNote] = useState('');
  const [pending, startTransition] = useTransition();

  const set = <K extends keyof PolicyForm>(key: K, value: PolicyForm[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const save = (): void => {
    const invalid = validateForm(form);
    if (invalid != null) {
      if (invalid.key === 'invalidNumber') {
        toast.error(
          t('invalidNumber', { field: t(invalid.field), min: invalid.min, max: invalid.max }),
        );
      } else if (invalid.key === 'notInteger') {
        toast.error(t('notInteger', { field: t(invalid.field) }));
      } else {
        toast.error(t('baseExceedsMax'));
      }
      return;
    }
    startTransition(async () => {
      const policy = buildPolicy(form);
      const res = await saveRoutingPolicyAction({ policy, note: note || undefined });
      if (res.ok) {
        toast.success(t('saved', { version: res.version ?? '?' }));
        setNote('');
        // 保存后回填规范化值（UI 与持久值不漂移）
        setForm(formOf(policy));
      } else {
        toast.error(res.error);
      }
    });
  };

  return (
    <div className="space-y-6">
      <section className="rounded-lg border p-4">
        <header className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">{t('policyTitle')}</h2>
          <span className="text-muted-foreground text-xs">
            {current == null
              ? t('unconfigured')
              : t('currentVersion', { version: current.version })}
          </span>
        </header>
        <PolicyFormCards form={form} set={set} t={t} />
        <div className="mt-4 flex items-center gap-2">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('notePlaceholder')}
            maxLength={255}
            className="h-9 max-w-xs"
          />
          <Button onClick={save} disabled={pending}>
            {pending ? t('saving') : t('save')}
          </Button>
        </div>
        <p className="text-muted-foreground mt-2 text-xs">{t('hotEffectHint')}</p>
      </section>
      <ChannelOverviewTable rows={overview} t={t} />
    </div>
  );
}
