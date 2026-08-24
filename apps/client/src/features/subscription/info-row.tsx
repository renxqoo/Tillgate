'use client';

// 订阅域展示行：label 与值左右对齐的哑件（续费/加购/购买/升级弹窗汇总区共用）

export function InfoRow({
  label,
  children,
  emphasize = false,
}: {
  label: string;
  children: React.ReactNode;
  emphasize?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={`text-right tabular-nums ${emphasize ? 'font-semibold text-foreground' : 'font-medium'}`}
      >
        {children}
      </span>
    </div>
  );
}
