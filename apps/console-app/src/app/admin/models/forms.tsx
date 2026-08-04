'use client';

import { useState } from 'react';
import { Dialog, Field, Input, Feedback, ConfirmButton } from '@/components/dialog';
import { createModelAction, updateModelAction, deleteModelAction, bindModelChannelsAction } from '../actions';
import { liPerMillionToYuan } from '@/lib/api-client';

interface ModelRow {
  id: number;
  externalName: string;
  realModel: string;
  status: number;
  inputPrice: number;
  outputPrice: number;
  cacheInputPrice: number;
}

/** 新建模型映射 */
export function CreateModelForm({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [result, setResult] = useState<{ error?: string } | null>(null);
  return (
    <Dialog open={open} onClose={onClose} title="新建模型映射">
      <form
        action={async (fd) => {
          const r = await createModelAction(fd);
          setResult(r);
          if (!r.error) setTimeout(onClose, 800);
        }}
        className="space-y-3"
      >
        <Field label="对外模型名" hint="客户端在 model 字段填的名字">
          <Input name="externalName" required placeholder="如 gpt-4o / deepseek-chat" />
        </Field>
        <Field label="真实模型名" hint="上游供应商的实际模型名">
          <Input name="realModel" required placeholder="如 deepseek-chat" />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="输入价（元/百万token）" hint="官方价">
            <Input name="inputPrice" type="number" step="0.0001" defaultValue="0" />
          </Field>
          <Field label="输出价（元/百万token）" hint="官方价">
            <Input name="outputPrice" type="number" step="0.0001" defaultValue="0" />
          </Field>
          <Field label="缓存输入价（元/百万token）" hint="缓存命中价">
            <Input name="cacheInputPrice" type="number" step="0.0001" defaultValue="0" />
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

/** 编辑模型映射 */
export function EditModelForm({ model, open, onClose }: { model: ModelRow; open: boolean; onClose: () => void }) {
  const [result, setResult] = useState<{ error?: string } | null>(null);
  return (
    <Dialog open={open} onClose={onClose} title={`编辑模型 #${model.id} (${model.externalName})`}>
      <form
        action={async (fd) => {
          const r = await updateModelAction(model.id, fd);
          setResult(r);
          if (!r.error) setTimeout(onClose, 800);
        }}
        className="space-y-3"
      >
        <Field label="对外模型名">
          <Input name="externalName" defaultValue={model.externalName} required />
        </Field>
        <Field label="真实模型名">
          <Input name="realModel" defaultValue={model.realModel} required />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="输入价（元/M）">
            <Input name="inputPrice" type="number" step="0.0001" defaultValue={liPerMillionToYuan(model.inputPrice)} />
          </Field>
          <Field label="输出价（元/M）">
            <Input name="outputPrice" type="number" step="0.0001" defaultValue={liPerMillionToYuan(model.outputPrice)} />
          </Field>
          <Field label="缓存输入价（元/M）">
            <Input name="cacheInputPrice" type="number" step="0.0001" defaultValue={liPerMillionToYuan(model.cacheInputPrice)} />
          </Field>
        </div>
        <Field label="状态">
          <select name="status" defaultValue={String(model.status)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
            <option value="0">上架</option>
            <option value="1">下架</option>
          </select>
        </Field>
        <Feedback result={result} />
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-md border px-4 py-1.5 text-sm">取消</button>
          <button type="submit" className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground">保存</button>
        </div>
      </form>
    </Dialog>
  );
}

/** 绑定渠道 */
export function BindChannelsForm({ model, open, onClose }: { model: ModelRow; open: boolean; onClose: () => void }) {
  const [result, setResult] = useState<{ error?: string } | null>(null);
  return (
    <Dialog open={open} onClose={onClose} title={`绑定渠道 #${model.id} (${model.externalName})`}>
      <form
        action={async (fd) => {
          const r = await bindModelChannelsAction(model.id, fd);
          setResult(r);
          if (!r.error) setTimeout(onClose, 800);
        }}
        className="space-y-3"
      >
        <Field label="渠道绑定（全量替换）" hint="JSON 数组，每项 {channelId, weight?, priority?}。提交后覆盖现有绑定">
          <textarea
            name="channels"
            rows={6}
            required
            defaultValue="[]"
            className="w-full rounded border bg-background p-2 font-mono text-xs"
            placeholder={'[\n  {"channelId": 1, "weight": 1, "priority": 0}\n]'}
          />
        </Field>
        <Feedback result={result} />
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-md border px-4 py-1.5 text-sm">取消</button>
          <button type="submit" className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground">绑定</button>
        </div>
      </form>
    </Dialog>
  );
}

/** 删除模型 */
export function DeleteModelButton({ id }: { id: number }) {
  return (
    <ConfirmButton
      label="删除"
      confirmText="确认删除？"
      onConfirm={async () => { await deleteModelAction(id); }}
    />
  );
}
