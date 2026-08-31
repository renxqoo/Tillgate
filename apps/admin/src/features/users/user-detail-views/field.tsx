import type { ReactNode } from 'react';

/** 资料卡字段（label + 值）；value 允许 ReactNode 以承载 LocalTime 等客户端子组件 */
export function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
