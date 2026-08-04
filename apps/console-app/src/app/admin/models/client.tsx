'use client';

import { useState } from 'react';
import { EditModelForm, BindChannelsForm, DeleteModelButton } from './forms';

interface ModelRow {
  id: number;
  externalName: string;
  realModel: string;
  status: number;
  inputPrice: number;
  outputPrice: number;
  cacheInputPrice: number;
}

/** 模型行操作：编辑/绑定渠道/删除 */
export default function ModelActions({ model }: { model: ModelRow }) {
  const [editOpen, setEditOpen] = useState(false);
  const [bindOpen, setBindOpen] = useState(false);
  return (
    <div className="flex justify-end gap-2">
      <button onClick={() => setEditOpen(true)} className="rounded-md border px-3 py-1 text-xs hover:bg-muted">编辑</button>
      <button onClick={() => setBindOpen(true)} className="rounded-md border px-3 py-1 text-xs hover:bg-muted">绑定渠道</button>
      <EditModelForm model={model} open={editOpen} onClose={() => setEditOpen(false)} />
      <BindChannelsForm model={model} open={bindOpen} onClose={() => setBindOpen(false)} />
      <DeleteModelButton id={model.id} />
    </div>
  );
}
