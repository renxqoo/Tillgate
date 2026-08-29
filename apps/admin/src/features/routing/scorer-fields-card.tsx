/** 策略表单卡：渠道选择倾向（缓存亲和 / 预算降权——状态与保存留在编排器） */
import { Input, Switch } from '@tillgate/ui';
import type { PolicyForm } from './routing-content-types';

export function ScorerFieldsCard({
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
      <h3 className="text-sm font-medium">{t('scorers')}</h3>
      <div className="space-y-1">
        <label className="flex items-center justify-between gap-2 text-sm">
          <span>{t('cacheAffinity')}</span>
          <Switch
            checked={form.cacheAffinityEnabled}
            onCheckedChange={(v) => set('cacheAffinityEnabled', v)}
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
          />
        </div>
        <p className="text-xs text-muted-foreground">{t('boostHint')}</p>
      </div>
      <div className="space-y-1">
        <label className="flex items-center justify-between gap-2 text-sm">
          <span>{t('budgetWatermark')}</span>
          <Switch
            checked={form.budgetWatermarkEnabled}
            onCheckedChange={(v) => set('budgetWatermarkEnabled', v)}
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
          />
        </div>
        <p className="text-xs text-muted-foreground">{t('softRatioHint')}</p>
      </div>
    </div>
  );
}
