'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/**
 * 简易弹窗（无第三方依赖，纯状态控制）。
 * 用于管理后台各类 CRUD 表单的容器。
 */
export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="关闭">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** 触发弹窗的按钮（受控） */
export function DialogTrigger({ label, onOpen, variant }: { label: string; onOpen: () => void; variant?: 'default' | 'outline' | 'destructive' }) {
  return (
    <Button variant={variant ?? 'default'} onClick={onOpen}>
      {label}
    </Button>
  );
}

/** 表单字段封装（label + input） */
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** 通用文本输入框（与 shadcn 风格一致） */
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${props.className ?? ''}`}
    />
  );
}

/** 危险操作确认按钮（点击后需二次确认） */
export function ConfirmButton({
  label,
  onConfirm,
  variant = 'destructive',
  confirmText = '确认？',
}: {
  label: string;
  onConfirm: () => Promise<void> | void;
  variant?: 'default' | 'outline' | 'destructive';
  confirmText?: string;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  if (armed) {
    return (
      <Button
        variant={variant}
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onConfirm();
            setArmed(false);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? '处理中…' : confirmText}
      </Button>
    );
  }
  return (
    <Button variant={variant} size="sm" onClick={() => setArmed(true)}>
      {label}
    </Button>
  );
}

/** 操作反馈条（成功/错误消息） */
export function Feedback({ result }: { result: { error?: string } | { ok?: boolean } | null }) {
  if (!result) return null;
  if ('error' in result && result.error) {
    return <p className="mt-2 text-sm text-destructive">{result.error}</p>;
  }
  if ('ok' in result && result.ok) {
    return <p className="mt-2 text-sm text-primary">操作成功</p>;
  }
  return null;
}
