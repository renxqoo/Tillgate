'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/copy-button';
import { createKeyAction, revokeKeyAction } from './actions';

/** 创建 Key 表单（明文仅此一次回显） */
export function CreateKeyForm() {
  const [result, setResult] = useState<{ error?: string; key?: string } | null>(null);
  return (
    <form
      action={async (fd) => {
        const r = await createKeyAction(fd);
        setResult(r);
      }}
      className="space-y-3"
    >
      <div className="flex gap-2">
        <input
          name="name"
          placeholder="Key 名称"
          required
          className="flex h-9 flex-1 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
        />
        <input
          name="remark"
          placeholder="备注（可选）"
          className="flex h-9 flex-1 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
        />
        <Button type="submit">创建</Button>
      </div>
      {result?.error && <p className="text-sm text-destructive">{result.error}</p>}
      {result?.key && (
        <div className="rounded-md bg-primary/5 p-3">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Key 明文（仅此一次，请立即保存）：</p>
            <CopyButton text={result.key} />
          </div>
          <code className="break-all text-sm">{result.key}</code>
        </div>
      )}
    </form>
  );
}

/** 吊销 Key 按钮 */
export function RevokeKeyButton({ id }: { id: number }) {
  return (
    <form
      action={async () => {
        await revokeKeyAction(id);
      }}
    >
      <Button type="submit" variant="destructive" size="sm">
        吊销
      </Button>
    </form>
  );
}
