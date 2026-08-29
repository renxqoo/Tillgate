/** 策略表单卡：重试与错误恢复（重试 / 熔断 / 冷却 / 兜底——状态与保存留在编排器） */
import { Input, Switch } from '@tillgate/ui';
import type { PolicyForm } from './routing-content-types';

export function ResilienceFieldsCard({
  form,
  set,
  t,
}: {
  form: PolicyForm;
  set: <K extends keyof PolicyForm>(key: K, value: PolicyForm[K]) => void;
  t: (k: string) => string;
}) {
  return (
    <div className="space-y-4 rounded-md border p-3">
      <h3 className="text-sm font-medium">{t('resilience')}</h3>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>{t('retries')}</span>
          <Input
            value={form.sameChannelMaxRetries}
            onChange={(e) => set('sameChannelMaxRetries', e.target.value)}
            className="h-8 w-24"
            inputMode="numeric"
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
            className="h-8 w-24"
            inputMode="numeric"
          />
        </div>
        <p className="text-xs text-muted-foreground">{t('modelDeadThresholdHint')}</p>
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>{t('penaltyBase')}</span>
          <Input
            value={form.rateLimitBaseMs}
            onChange={(e) => set('rateLimitBaseMs', e.target.value)}
            className="h-8 w-28"
            inputMode="numeric"
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
          />
        </div>
        <p className="text-xs text-muted-foreground">{t('quotaCooldownHint')}</p>
      </div>
      <div className="space-y-1">
        <label className="flex items-center justify-between gap-2 text-sm">
          <span>{t('conditionalBypass')}</span>
          <Switch
            checked={form.conditionalBypass}
            onCheckedChange={(v) => set('conditionalBypass', v)}
          />
        </label>
        <p className="text-xs text-muted-foreground">{t('conditionalBypassHint')}</p>
      </div>
      <div className="space-y-1">
        <label className="flex items-center justify-between gap-2 text-sm">
          <span>{t('boundedWait')}</span>
          <Switch checked={form.waitEnabled} onCheckedChange={(v) => set('waitEnabled', v)} />
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
          />
        </div>
        <p className="text-xs text-muted-foreground">{t('maxWaitHint')}</p>
      </div>
    </div>
  );
}
