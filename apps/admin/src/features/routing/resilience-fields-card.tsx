/** 策略表单卡：冷却与等待恢复（限流/额度冷却 / 兜底与等待——状态与保存留在编排器） */
import { Input, Switch } from '@tillgate/ui';
import type { PolicyForm } from './routing-content-types';

export function ResilienceFieldsCard({
  form,
  set,
  t,
  disabled = false,
}: {
  form: PolicyForm;
  set: <K extends keyof PolicyForm>(key: K, value: PolicyForm[K]) => void;
  t: (k: string) => string;
  /** 总开关关闭时禁用编辑（值保留，提交仍透传）；禁用说明由弹窗顶部提示条统一承担 */
  disabled?: boolean;
}) {
  return (
    <div className={`space-y-4 rounded-md border p-4${disabled ? ' opacity-60' : ''}`}>
      <h3 className="text-sm font-medium">{t('cooldownRecovery')}</h3>
      <section className="space-y-3">
        <p className="text-muted-foreground text-xs font-medium">{t('groupCooldown')}</p>
        {/* 基数/上限是 baseExceedsMax 校验的耦合对，相邻呈现 */}
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span>{t('penaltyBase')}</span>
            <Input
              value={form.rateLimitBaseMs}
              onChange={(e) => set('rateLimitBaseMs', e.target.value)}
              className="h-8 w-28"
              inputMode="numeric"
              disabled={disabled}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('penaltyBaseHint')}</p>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span>{t('penaltyMax')}</span>
            <Input
              value={form.rateLimitMaxMs}
              onChange={(e) => set('rateLimitMaxMs', e.target.value)}
              className="h-8 w-28"
              inputMode="numeric"
              disabled={disabled}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('penaltyMaxHint')}</p>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span>{t('quotaCooldown')}</span>
            <Input
              value={form.quotaMs}
              onChange={(e) => set('quotaMs', e.target.value)}
              className="h-8 w-28"
              inputMode="numeric"
              disabled={disabled}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('quotaCooldownHint')}</p>
        </div>
      </section>
      <section className="space-y-3">
        <p className="text-muted-foreground text-xs font-medium">{t('groupFallbackWait')}</p>
        <div className="space-y-1">
          <label className="flex items-center justify-between gap-2 text-sm">
            <span>{t('conditionalBypass')}</span>
            <Switch
              checked={form.conditionalBypass}
              onCheckedChange={(v) => set('conditionalBypass', v)}
              disabled={disabled}
            />
          </label>
          <p className="text-xs text-muted-foreground">{t('conditionalBypassHint')}</p>
        </div>
        <div className="space-y-1">
          <label className="flex items-center justify-between gap-2 text-sm">
            <span>{t('boundedWait')}</span>
            <Switch
              checked={form.waitEnabled}
              onCheckedChange={(v) => set('waitEnabled', v)}
              disabled={disabled}
            />
          </label>
          <p className="text-xs text-muted-foreground">{t('boundedWaitHint')}</p>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span>{t('maxWait')}</span>
            <Input
              value={form.maxWaitMs}
              onChange={(e) => set('maxWaitMs', e.target.value)}
              className="h-8 w-28"
              inputMode="numeric"
              disabled={disabled}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('maxWaitHint')}</p>
        </div>
      </section>
    </div>
  );
}
