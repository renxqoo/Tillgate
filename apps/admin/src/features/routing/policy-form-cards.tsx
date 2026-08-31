/** 策略表单双卡组合：左「渠道选择与重试」右「冷却与等待恢复」，各 6 字段保列高对称 */
import { ResilienceFieldsCard } from './resilience-fields-card';
import { ScorerFieldsCard } from './scorer-fields-card';
import type { PolicyForm } from './routing-content-types';

export function PolicyFormCards({
  form,
  set,
  t,
  routingEnabled,
}: {
  form: PolicyForm;
  set: <K extends keyof PolicyForm>(key: K, value: PolicyForm[K]) => void;
  t: (k: string) => string;
  /** 总开关关闭时卡片呈禁用态：字段灰化不可编辑，但值保留（提交仍透传） */
  routingEnabled: boolean;
}) {
  // 两卡各 6 字段（2 开关 + 4 数值）、卡内按小节分组，lg 并排时列高接近；
  // 768–1023 保持单列堆叠——并排会把「label 左 + 控件右」的行挤到逐字折行
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <ScorerFieldsCard form={form} set={set} t={t} disabled={!routingEnabled} />
      <ResilienceFieldsCard form={form} set={set} t={t} disabled={!routingEnabled} />
    </div>
  );
}
