'use client';

import { useState } from 'react';
import { Dialog, Field, Input, Feedback, ConfirmButton } from '@/components/dialog';
import { updateChannelAction, deleteChannelAction, testChannelAction } from '../actions';
import { msToHuman } from '@/lib/api-client';

interface ChannelRow {
  id: number;
  name: string;
  providerName: string;
  status: number;
  failCount: number;
  weight: number;
  priority: number;
  cooldownUntil: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  baseUrlOverride: string | null;
}

const STATUS_OPTIONS = [
  { value: '0', label: '启用' },
  { value: '1', label: '禁用' },
  { value: '2', label: '维护' },
];

/** 渠道行操作：编辑/测试/删除 */
export default function ChannelActions({ channel }: { channel: ChannelRow }) {
  return (
    <div className="flex justify-end gap-2">
      <EditButton channel={channel} />
      <TestButton id={channel.id} />
      <DeleteButton id={channel.id} />
    </div>
  );
}

function EditButton({ channel }: { channel: ChannelRow }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ error?: string } | null>(null);
  return (
    <>
      <button onClick={() => setOpen(true)} className="rounded-md border px-3 py-1 text-xs hover:bg-muted">编辑</button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`编辑渠道 #${channel.id} (${channel.name})`}>
        <form
          action={async (fd) => {
            const r = await updateChannelAction(channel.id, fd);
            setResult(r);
            if (!r.error) setTimeout(() => setOpen(false), 800);
          }}
          className="space-y-3"
        >
          <Field label="名称">
            <Input name="name" defaultValue={channel.name} />
          </Field>
          <Field label="BaseURL 覆盖（可选，留空用供应商默认）">
            <Input name="baseUrlOverride" defaultValue={channel.baseUrlOverride ?? ''} placeholder="https://api.example.com" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="权重">
              <Input name="weight" type="number" defaultValue={channel.weight} />
            </Field>
            <Field label="优先级">
              <Input name="priority" type="number" defaultValue={channel.priority} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="RPM 限流（可选）">
              <Input name="rpmLimit" type="number" defaultValue={channel.rpmLimit ?? ''} placeholder="不填=不限" />
            </Field>
            <Field label="TPM 限流（可选）">
              <Input name="tpmLimit" type="number" defaultValue={channel.tpmLimit ?? ''} placeholder="不填=不限" />
            </Field>
          </div>
          <Field label="状态">
            <select name="status" defaultValue={String(channel.status)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
              {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </Field>
          <Field label="更换 API Key（可选）" hint="填写则覆盖旧 Key，并清除凭据无效状态">
            <Input name="apiKey" type="password" placeholder="留空不换 Key" />
          </Field>
          <Feedback result={result} />
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setOpen(false)} className="rounded-md border px-4 py-1.5 text-sm">取消</button>
            <button type="submit" className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground">保存</button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function TestButton({ id }: { id: number }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ ok?: boolean; error?: string; result?: { ok: boolean; durationMs?: number; error?: { code?: string; message?: string } } } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button
        onClick={async () => {
          setOpen(true);
          setBusy(true);
          setResult(null);
          const r = await testChannelAction(id);
          setResult(r);
          setBusy(false);
        }}
        className="rounded-md border px-3 py-1 text-xs hover:bg-muted"
      >
        测试
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`连通性测试 #${id}`}>
        <div className="space-y-2 text-sm">
          {busy && <p className="text-muted-foreground">测试中…</p>}
          {result?.error && <p className="text-destructive">{result.error}</p>}
          {result?.result && (
            <div className={`rounded-md p-3 ${result.result.ok ? 'bg-primary/5 text-primary' : 'bg-destructive/5 text-destructive'}`}>
              <p className="font-medium">{result.result.ok ? '✓ 连通正常' : '✗ 连接失败'}</p>
              {result.result.durationMs != null && <p className="text-xs">耗时 {msToHuman(result.result.durationMs)}</p>}
              {result.result.error && <p className="text-xs">错误: {result.result.error.code} — {result.result.error.message}</p>}
            </div>
          )}
        </div>
      </Dialog>
    </>
  );
}

function DeleteButton({ id }: { id: number }) {
  return (
    <ConfirmButton
      label="删除"
      confirmText="确认删除？"
      onConfirm={async () => { await deleteChannelAction(id); }}
    />
  );
}
