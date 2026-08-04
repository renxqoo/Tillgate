'use client';

import { useState } from 'react';
import { Dialog, Field, Input, Feedback } from '@/components/dialog';
import { createChannelAction, importChannelsAction } from '../actions';

interface Provider {
  id: number;
  name: string;
}

/** 新建渠道（弹窗） */
export function CreateChannelForm({ open, onClose, providers }: { open: boolean; onClose: () => void; providers: Provider[] }) {
  const [result, setResult] = useState<{ error?: string } | null>(null);
  return (
    <Dialog open={open} onClose={onClose} title="新建渠道">
      <form
        action={async (fd) => {
          const r = await createChannelAction(fd);
          setResult(r);
          if (!r.error) setTimeout(onClose, 800);
        }}
        className="space-y-3"
      >
        <Field label="供应商">
          <select name="providerId" required className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
            <option value="">请选择…</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name} (#{p.id})</option>)}
          </select>
        </Field>
        <Field label="名称">
          <Input name="name" required placeholder="如 deepseek-default" />
        </Field>
        <Field label="API Key" hint="上游供应商的真实 Key，加密存储，不回显">
          <Input name="apiKey" type="password" required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="权重">
            <Input name="weight" type="number" defaultValue="1" />
          </Field>
          <Field label="优先级">
            <Input name="priority" type="number" defaultValue="0" />
          </Field>
        </div>
        <Feedback result={result} />
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-md border px-4 py-1.5 text-sm">取消</button>
          <button type="submit" className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground">创建</button>
        </div>
      </form>
    </Dialog>
  );
}

/** 批量导入渠道（弹窗） */
export function ImportChannelsForm({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [result, setResult] = useState<{ error?: string; result?: { total: number; success: number; failed: number } } | null>(null);
  return (
    <Dialog open={open} onClose={onClose} title="批量导入渠道">
      <form
        action={async (fd) => {
          const r = await importChannelsAction(fd);
          setResult(r);
        }}
        className="space-y-3"
      >
        <Field label="JSON 数组" hint="每项 {provider, name, apiKey, models?, weight?, priority?}。provider 需先在供应商页创建">
          <textarea
            name="json"
            rows={10}
            required
            className="w-full rounded border bg-background p-2 font-mono text-xs"
            placeholder={'[\n  {"provider":"deepseek","name":"deepseek-2","apiKey":"sk-xxx","models":["deepseek-chat"]},\n  {"provider":"minimax","name":"minimax-backup","apiKey":"sk-yyy"}\n]'}
          />
        </Field>
        <Feedback result={result} />
        {result?.result && (
          <div className="rounded-md bg-primary/5 p-3 text-sm">
            共 {result.result.total} 条，成功 {result.result.success}，失败 {result.result.failed}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-md border px-4 py-1.5 text-sm">关闭</button>
          <button type="submit" className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground">导入</button>
        </div>
      </form>
    </Dialog>
  );
}
