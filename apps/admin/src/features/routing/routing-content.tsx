'use client';

/**
 * 智能路由管理编排（策略面）：总开关常驻页面（最高频操作）；策略参数（评分器/韧性双卡）
 * 收进「策略配置」弹窗，保存沿用原有 action / toast / revalidate 链路。
 * 渠道观测表在页面层渲染（URL 排序/窗口——见 page.tsx），不属本编排器。
 *
 * 表单状态取舍：state 保持在编排器（弹窗外），弹窗开关不卸载字段组件——已填未保存的
 * 值始终保留在内存中，取消仅关闭弹窗、不丢弃草稿，下次打开继续编辑（交互无损且零成本）。
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button, Input, Switch } from '@tillgate/ui';
import { FormDialog } from '@/components/form-dialog';
import { saveRoutingPolicyAction } from '@/server/routing-actions';
import { buildPolicy, formOf, validateForm } from './routing-policy-form';
import { PolicyFormCards } from './policy-form-cards';
import type { PolicyForm, RoutingPolicyView } from './routing-content-types';

export type { RoutingPolicyView } from './routing-content-types';

export function RoutingClient({
  current,
  fallback,
}: {
  current: RoutingPolicyView | null;
  fallback: Record<string, unknown>;
}) {
  const t = useTranslations('routing');
  const [form, setForm] = useState<PolicyForm>(formOf(current?.policy ?? fallback));
  const [note, setNote] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);

  const set = <K extends keyof PolicyForm>(key: K, value: PolicyForm[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  // 保存逻辑不变（校验 → action → toast → 回填规范化值）；返回是否成功供弹窗决定是否关闭
  const save = async (): Promise<boolean> => {
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
      return false;
    }
    const policy = buildPolicy(form);
    const res = await saveRoutingPolicyAction({ policy, note: note || undefined });
    if (res.ok) {
      toast.success(t('saved', { version: res.version ?? '?' }));
      setNote('');
      // 保存后回填规范化值（UI 与持久值不漂移）
      setForm(formOf(policy));
      return true;
    }
    toast.error(res.error);
    return false;
  };

  // 总开关即拨即存（最高频操作不进弹窗）：以当前表单值 + 新 enabled 整版保存，
  // 失败回滚 UI 状态——开关与库值不得出现「看着开了实际没存」的假生效
  const toggleEnabled = async (next: boolean): Promise<void> => {
    const previous = form;
    setForm({ ...form, enabled: next });
    const res = await saveRoutingPolicyAction({ policy: buildPolicy({ ...form, enabled: next }) });
    if (res.ok) {
      toast.success(t('saved', { version: res.version ?? '?' }));
      setForm(formOf(buildPolicy({ ...form, enabled: next })));
      return;
    }
    setForm(previous);
    toast.error(res.error);
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
        <div className="flex items-center justify-between gap-3 rounded-md border p-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('masterEnabled')}</p>
            <p className="text-xs text-muted-foreground">
              {form.enabled ? t('masterEnabledOnHint') : t('masterEnabledOffHint')}
            </p>
          </div>
          <Switch checked={form.enabled} onCheckedChange={(v) => void toggleEnabled(v)} />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button variant="outline" onClick={() => setDialogOpen(true)}>
            {t('editPolicy')}
          </Button>
          <p className="text-muted-foreground text-xs">{t('hotEffectHint')}</p>
        </div>
      </section>
      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={t('policyDialogTitle')}
        description={t('policyDialogDescription')}
        submitLabel={t('save')}
        contentClassName="sm:max-w-3xl"
        onSubmitClick={save}
      >
        <div className="space-y-4">
          {/* 总开关关闭时的禁用说明全弹窗只渲染这一条（曾两卡各一条，重复）；卡内保留字段灰化 */}
          {form.enabled ? null : (
            <p className="text-muted-foreground rounded-md bg-muted px-3 py-2 text-xs">
              {t('paramsDisabledHint')}
            </p>
          )}
          <PolicyFormCards form={form} set={set} t={t} routingEnabled={form.enabled} />
          {/* 变更备注通栏贴 footer（footer 自带分隔线与底色），与保存动作构成「提交区」 */}
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('notePlaceholder')}
            maxLength={255}
            className="h-9 w-full"
          />
        </div>
      </FormDialog>
    </div>
  );
}
