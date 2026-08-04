'use client';

import { useState } from 'react';
import { CreateModelForm } from './forms';

/** 新建模型按钮（点击弹窗） */
export default function CreateButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground"
      >
        新建模型
      </button>
      <CreateModelForm open={open} onClose={() => setOpen(false)} />
    </>
  );
}
