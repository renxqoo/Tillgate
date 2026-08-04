'use client';

import { useState } from 'react';
import { CreateRateCardForm } from './forms';

/** 新建费率卡按钮（点击弹窗） */
export default function CreateButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground"
      >
        新建费率卡
      </button>
      <CreateRateCardForm open={open} onClose={() => setOpen(false)} />
    </>
  );
}
