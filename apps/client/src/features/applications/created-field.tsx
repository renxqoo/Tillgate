'use client';

import { CopyButton } from '@tillgate/ui';

export function CreatedField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <code
          className={`flex-1 break-all rounded bg-background/80 p-2 text-xs ${mono ? 'font-mono' : ''}`}
        >
          {value}
        </code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}
