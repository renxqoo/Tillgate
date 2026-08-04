'use client';

import { useState } from 'react';
import { Dialog, Field, Input, Feedback, ConfirmButton } from '@/components/dialog';
import { createRateCardAction, updateRateCardAction, deleteRateCardAction } from '../actions';

/** 新建费率卡（弹窗） */
export function CreateRateCardForm({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [result, setResult] = useState<{ error?: string } | null>(null);
  return (
    <Dialog open={open} onClose={onClose} title="新建费率卡">
      <form
        action={async (fd) => {
          const r = await createRateCardAction(fd);
          setResult(r);
          if (!r.error) setTimeout(onClose, 800);
        }}
        className="space-y-3"
      >
        <Field label="名称">
          <Input name="name" required placeholder="如：标准 / 快速 / 套餐A" />
        </Field>
        <Field label="全局系数" hint="1.0 = 官方原价；0.8 = 八折；1.5 = 加价 50%">
          <Input name="coefficient" type="number" step="0.001" min={0} max={9.999} required placeholder="1.000" />
        </Field>
        <Field label="描述（可选）">
          <Input name="description" placeholder="费率卡说明" />
        </Field>
        <Feedback result={result} />
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-md border px-4 py-1.5 text-sm">取消</button>
          <button type="submit" className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground">创建</button>
        </div>
      </form>
    </Dialog>
  );
}

/** 编辑费率卡（弹窗） */
export function EditRateCardForm({ card, open, onClose }: { card: { id: number; name: string; coefficient: string; description: string | null; status: number }; open: boolean; onClose: () => void }) {
  const [result, setResult] = useState<{ error?: string } | null>(null);
  return (
    <Dialog open={open} onClose={onClose} title={`编辑费率卡 #${card.id}`}>
      <form
        action={async (fd) => {
          const r = await updateRateCardAction(card.id, fd);
          setResult(r);
          if (!r.error) setTimeout(onClose, 800);
        }}
        className="space-y-3"
      >
        <Field label="名称">
          <Input name="name" defaultValue={card.name} required />
        </Field>
        <Field label="全局系数">
          <Input name="coefficient" type="number" step="0.001" min={0} max={9.999} defaultValue={card.coefficient} required />
        </Field>
        <Field label="描述">
          <Input name="description" defaultValue={card.description ?? ''} />
        </Field>
        <Field label="状态">
          <select name="status" defaultValue={String(card.status)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
            <option value="0">启用</option>
            <option value="1">停用</option>
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

/** 删除费率卡按钮（二次确认） */
export function DeleteRateCardButton({ id }: { id: number }) {
  return (
    <ConfirmButton
      label="删除"
      confirmText="确认删除？"
      onConfirm={async () => {
        await deleteRateCardAction(id);
      }}
    />
  );
}
