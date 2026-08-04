'use client';

import { useState } from 'react';
import { EditRateCardForm, DeleteRateCardButton } from './forms';

interface RateCardRow {
  id: number;
  name: string;
  description: string | null;
  status: number;
  coefficient: string;
}

/** 费率卡行操作按钮（编辑/删除） */
export default function RateCardActions({ card }: { card: RateCardRow }) {
  const [editOpen, setEditOpen] = useState(false);
  return (
    <div className="flex justify-end gap-2">
      <button onClick={() => setEditOpen(true)} className="rounded-md border px-3 py-1 text-xs hover:bg-muted">
        编辑
      </button>
      <EditRateCardForm card={card} open={editOpen} onClose={() => setEditOpen(false)} />
      <DeleteRateCardButton id={card.id} />
    </div>
  );
}
