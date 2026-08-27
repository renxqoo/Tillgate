'use client';

export function SourceBadge({ label, balanceLabel }: { label: string; balanceLabel: string }) {
  const isBalance = label === balanceLabel;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        isBalance
          ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
          : 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
      }`}
    >
      {label}
    </span>
  );
}
