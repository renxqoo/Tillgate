/** 策略表单双卡组合（渠道选择倾向 / 重试与错误恢复——卡片实现各自单文件） */
import { ResilienceFieldsCard } from './resilience-fields-card';
import { ScorerFieldsCard } from './scorer-fields-card';
import type { PolicyForm } from './routing-content-types';

export function PolicyFormCards({
  form,
  set,
  t,
}: {
  form: PolicyForm;
  set: <K extends keyof PolicyForm>(key: K, value: PolicyForm[K]) => void;
  t: (k: string) => string;
}) {
  // 两卡字段数不对称（4 vs 8）：按内容自适应高度，避免矮卡底部大片留白；
  // lg 起才并排，768–1023 并排会把标签挤到逐字折行
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <ScorerFieldsCard form={form} set={set} t={t} />
      <ResilienceFieldsCard form={form} set={set} t={t} />
    </div>
  );
}
