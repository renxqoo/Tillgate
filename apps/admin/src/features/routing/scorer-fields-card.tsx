/** 策略表单卡：渠道选择与重试（缓存亲和 / 余额降权 / 重试熔断——状态与保存留在编排器） */
import { Input, Switch } from '@tillgate/ui';
import type { PolicyForm } from './routing-content-types';

export function ScorerFieldsCard({
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
      <h3 className="text-sm font-medium">{t('channelRetry')}</h3>
      <section className="space-y-3">
        <p className="text-muted-foreground text-xs font-medium">{t('groupCacheAffinity')}</p>
        <div className="space-y-1">
          <label className="flex items-center justify-between gap-2 text-sm">
            <span>{t('cacheAffinity')}</span>
            <Switch
              checked={form.cacheAffinityEnabled}
              onCheckedChange={(v) => set('cacheAffinityEnabled', v)}
              disabled={disabled}
            />
          </label>
          <p className="text-xs text-muted-foreground">{t('cacheAffinityHint')}</p>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span>{t('boost')}</span>
            <Input
              value={form.cacheBoost}
              onChange={(e) => set('cacheBoost', e.target.value)}
              className="h-8 w-28"
              inputMode="numeric"
              disabled={disabled}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('boostHint')}</p>
        </div>
      </section>
      <section className="space-y-3">
        <p className="text-muted-foreground text-xs font-medium">{t('groupBudgetWatermark')}</p>
        <div className="space-y-1">
          <label className="flex items-center justify-between gap-2 text-sm">
            <span>{t('budgetWatermark')}</span>
            <Switch
              checked={form.budgetWatermarkEnabled}
              onCheckedChange={(v) => set('budgetWatermarkEnabled', v)}
              disabled={disabled}
            />
          </label>
          <p className="text-xs text-muted-foreground">{t('budgetWatermarkHint')}</p>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span>{t('softRatio')}</span>
            <Input
              value={form.softRatio}
              onChange={(e) => set('softRatio', e.target.value)}
              className="h-8 w-28"
              inputMode="decimal"
              disabled={disabled}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('softRatioHint')}</p>
        </div>
      </section>
      <section className="space-y-3">
        <p className="text-muted-foreground text-xs font-medium">{t('groupRetry')}</p>
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span>{t('retries')}</span>
            <Input
              value={form.sameChannelMaxRetries}
              onChange={(e) => set('sameChannelMaxRetries', e.target.value)}
              className="h-8 w-28"
              inputMode="numeric"
              disabled={disabled}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('retriesHint')}</p>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span>{t('modelDeadThreshold')}</span>
            <Input
              value={form.modelDeadThreshold}
              onChange={(e) => set('modelDeadThreshold', e.target.value)}
              className="h-8 w-28"
              inputMode="numeric"
              disabled={disabled}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('modelDeadThresholdHint')}</p>
        </div>
      </section>
    </div>
  );
}
