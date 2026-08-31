'use client';

// 分时段定价编辑器（schedule 策略，受控哑件）：窗口行 CRUD 走 onChange 单向数据流；
// 与参数差价的 strategy 单值互斥（启用即隐藏 variant）与提交优先级由消费方（PricingEditor）编排

import { Button, Checkbox, Input } from '@tillgate/ui';
import type { useTranslations } from 'next-intl';

import { unitWord } from '@/lib/formatters';
import { EMPTY_WINDOW_ROW, type WindowRow } from './billing-config-payload';

export function ScheduleWindowsEditor({
  scheduleOn,
  windows,
  unitMode,
  pricingUnit,
  locale,
  rootError,
  onScheduleToggle,
  onChange,
  pricePlaceholderOf,
  t,
  tc,
}: {
  /** 分时段是否启用（strategy=schedule；编排器持有，互斥与提交分流都依赖它） */
  scheduleOn: boolean;
  windows: WindowRow[];
  /** 单位计价（图片/视频/语音/按次）：窗口价格列显单位单价，token 显三元组 */
  unitMode: boolean;
  pricingUnit: string;
  locale: 'en' | 'zh';
  /** root 错误位（编排器 form.formState.errors.root）——提交校验失败信息在此渲染 */
  rootError?: { message?: string };
  /** 开关 schedule（编排器：setScheduleOn + 清 root 提交校验错误） */
  onScheduleToggle: (on: boolean) => void;
  /** 窗口行集合更新（setWindows 直传；函数式更新防行间 stale） */
  onChange: (update: (cur: WindowRow[]) => WindowRow[]) => void;
  /** 价格输入占位覆盖（成本轴继承回显：空输入显示实际将生效的继承值）；缺省回落各轴默认文案 */
  pricePlaceholderOf?: (
    axis: 'inputPrice' | 'outputPrice' | 'cacheInputPrice' | 'unitPrice',
  ) => string | undefined;
  t: ReturnType<typeof useTranslations<'models'>>;
  tc: ReturnType<typeof useTranslations<'common'>>;
}) {
  return (
    <div className="space-y-3 rounded-md border p-4">
      <label className="flex items-center gap-2 text-sm font-medium">
        <Checkbox checked={scheduleOn} onCheckedChange={(v) => onScheduleToggle(v === true)} />
        {t('scheduleTitle')}
      </label>
      <p className="text-xs text-muted-foreground">{t('scheduleHint')}</p>
      {scheduleOn ? (
        <div className="space-y-1.5">
          {windows.map((row, i) => {
            const patch = (next: Partial<WindowRow>) =>
              onChange((cur) => cur.map((r, j) => (j === i ? { ...r, ...next } : r)));
            return (
              <div key={i} className="space-y-2 rounded-md border border-input p-2.5">
                <div className="flex items-center gap-2">
                  <Input
                    value={row.label}
                    onChange={(e) => patch({ label: e.target.value })}
                    placeholder={t('windowLabelPlaceholder')}
                    className="h-8 w-32"
                  />
                  <Input
                    value={row.start}
                    onChange={(e) => patch({ start: e.target.value })}
                    placeholder="18:00"
                    className="h-8 w-24 font-mono"
                    inputMode="numeric"
                  />
                  <span className="text-xs text-muted-foreground">→</span>
                  <Input
                    value={row.end}
                    onChange={(e) => patch({ end: e.target.value })}
                    placeholder="07:00"
                    className="h-8 w-24 font-mono"
                    inputMode="numeric"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="ml-auto px-2 text-destructive hover:text-destructive"
                    onClick={() => onChange((cur) => cur.filter((_, j) => j !== i))}
                  >
                    {tc('remove')}
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {unitMode ? (
                    <div className="flex items-center gap-2">
                      <Input
                        value={row.unitPrice}
                        onChange={(e) => patch({ unitPrice: e.target.value })}
                        placeholder={pricePlaceholderOf?.('unitPrice') ?? t('unitPricePlaceholder')}
                        className="h-8 w-36"
                        inputMode="decimal"
                      />
                      <span className="w-14 text-xs text-muted-foreground">
                        ¥/{unitWord(pricingUnit, locale)}
                      </span>
                    </div>
                  ) : (
                    <>
                      <Input
                        value={row.inputPrice}
                        onChange={(e) => patch({ inputPrice: e.target.value })}
                        placeholder={pricePlaceholderOf?.('inputPrice') ?? t('inputPrice')}
                        className="h-8 w-32"
                        inputMode="decimal"
                      />
                      <Input
                        value={row.outputPrice}
                        onChange={(e) => patch({ outputPrice: e.target.value })}
                        placeholder={pricePlaceholderOf?.('outputPrice') ?? t('outputPrice')}
                        className="h-8 w-32"
                        inputMode="decimal"
                      />
                      <Input
                        value={row.cacheInputPrice}
                        onChange={(e) => patch({ cacheInputPrice: e.target.value })}
                        placeholder={pricePlaceholderOf?.('cacheInputPrice') ?? t('cachePrice')}
                        className="h-8 w-32"
                        inputMode="decimal"
                      />
                    </>
                  )}
                  <span className="text-xs text-muted-foreground">{t('windowPriceHint')}</span>
                </div>
              </div>
            );
          })}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onChange((cur) => [...cur, { ...EMPTY_WINDOW_ROW }])}
          >
            {t('addWindow')}
          </Button>
          {rootError ? (
            <p className="text-sm text-destructive">{rootError.message ?? t('windowsFillError')}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">{t('windowsHint')}</p>
        </div>
      ) : null}
    </div>
  );
}
