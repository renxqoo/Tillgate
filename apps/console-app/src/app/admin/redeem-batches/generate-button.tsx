'use client';

import { useState } from 'react';
import { CreateBatchForm } from './forms';

/** 生成批次按钮（点击弹窗） */
export default function GenerateButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground"
      >
        生成批次
      </button>
      <CreateBatchForm open={open} onClose={() => setOpen(false)} />
    </>
  );
}
