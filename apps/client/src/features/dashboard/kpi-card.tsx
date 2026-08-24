import { KpiCard as SharedKpiCard } from '@tillgate/ui';

/** 概览页指标卡：保留应用侧业务命名，视觉与共享 KPI 组件单源一致。 */
export function KpiCard({
  icon,
  title,
  value,
  sub,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  sub?: string;
  hint?: string;
}) {
  return <SharedKpiCard icon={icon} label={title} value={value} sub={sub} hint={hint} />;
}
