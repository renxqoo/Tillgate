'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/copy-button';
import { createAppAction } from './actions';

export function CreateAppForm() {
  const [result, setResult] = useState<{ error?: string; clientSecret?: string } | null>(null);
  return (
    <form
      action={async (fd) => {
        const r = await createAppAction(fd);
        setResult(r);
      }}
      className="space-y-3"
    >
      <div className="flex gap-2">
        <input
          name="name"
          placeholder="应用名称"
          required
          className="flex h-9 flex-1 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
        />
        <input
          name="description"
          placeholder="描述（可选）"
          className="flex h-9 flex-1 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
        />
        <Button type="submit">创建</Button>
      </div>
      {result?.error && <p className="text-sm text-destructive">{result.error}</p>}
      {result?.clientSecret && (
        <div className="rounded-md bg-primary/5 p-3">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-xs text-muted-foreground">client_secret（仅此一次，请立即保存）：</p>
            <CopyButton text={result.clientSecret} />
          </div>
          <code className="break-all text-sm">{result.clientSecret}</code>
          <p className="mt-1 text-xs text-muted-foreground">
            用 client_id + client_secret 调用 POST /oauth/token 换取 JWT（2h 有效）
          </p>
        </div>
      )}
    </form>
  );
}
