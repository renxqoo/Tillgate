'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { redeemAction } from './actions';
import { liToYuan } from '@/lib/api-client';

export function RedeemForm() {
  const [result, setResult] = useState<{ error?: string; ok?: boolean; balanceAfter?: number } | null>(null);
  const router = useRouter();
  return (
    <form
      action={async (fd) => {
        const r = await redeemAction(fd);
        setResult(r);
        if (r.ok) {
          router.refresh();
        }
      }}
      className="space-y-3"
    >
      <input
        name="code"
        placeholder="输入充值码（RC-xxxx）"
        required
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm font-mono"
      />
      <Button type="submit">兑换</Button>
      {result?.error && <p className="text-sm text-destructive">{result.error}</p>}
      {result?.ok && (
        <p className="text-sm text-primary">
          兑换成功！当前余额 ¥{liToYuan(result.balanceAfter ?? 0)}
        </p>
      )}
    </form>
  );
}
