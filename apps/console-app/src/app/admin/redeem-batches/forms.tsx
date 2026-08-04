'use client';

import { useState } from 'react';
import { Dialog, Field, Input, Feedback } from '@/components/dialog';
import { createRedeemBatchAction } from '../actions';

/** 生成充值码批次表单（弹窗） */
export function CreateBatchForm({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [result, setResult] = useState<{ error?: string; codes?: string[] } | null>(null);
  return (
    <Dialog open={open} onClose={onClose} title="生成充值码批次">
      <form
        action={async (fd) => {
          const r = await createRedeemBatchAction(fd);
          setResult(r);
        }}
        className="space-y-3"
      >
        <Field label="批次名称">
          <Input name="name" required placeholder="如：2026春节活动" />
        </Field>
        <Field label="面额（元）" hint="每张充值码的面值。如 5 = ¥5/张">
          <Input name="amount" type="number" step="0.01" min={0.01} required placeholder="5" />
        </Field>
        <Field label="数量" hint="本次生成的码数（1~10000）">
          <Input name="count" type="number" min={1} max={10000} required placeholder="100" />
        </Field>
        <Field label="备注（可选）">
          <Input name="remark" placeholder="活动说明" />
        </Field>
        <Feedback result={result} />
        {result?.codes && (
          <div className="rounded-md bg-primary/5 p-3">
            <p className="mb-2 text-xs text-muted-foreground">
              生成了 {result.codes.length} 张码（仅此一次显示，请立即复制保存）：
            </p>
            <textarea
              readOnly
              rows={6}
              className="w-full rounded border bg-background p-2 font-mono text-xs"
              defaultValue={result.codes.join('\n')}
              onClick={(e) => (e.target as HTMLTextAreaElement).select()}
            />
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-md border px-4 py-1.5 text-sm">
            关闭
          </button>
          <button type="submit" className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground">
            生成
          </button>
        </div>
      </form>
    </Dialog>
  );
}
