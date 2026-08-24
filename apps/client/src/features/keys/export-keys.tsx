'use client';

import { useState } from 'react';

import { DownloadIcon, Loader2Icon } from 'lucide-react';

import { Button, toast } from '@tillgate/ui';

import { exportKeysAction } from '@/server/actions/keys';

import { buildKeysTsv } from './export-tsv';

/**
 * Key 导出（B18 增强）：点击时经 server action 全量翻页拉取当前列表
 * （页面级导出语义保留——G1 筛选契约落地前即全部 Key），TSV 带 UTF-8 BOM
 * （Excel 中文兼容）；拉取失败以 toast 呈现后端错误文案。
 */
export function ExportKeys() {
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    try {
      const res = await exportKeysAction();
      if (!res.rows) {
        toast.error(res.error ?? 'Export failed');
        return;
      }
      const blob = new Blob([buildKeysTsv(res.rows)], { type: 'text/tab-separated-values' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `api-keys-${new Date().toISOString().slice(0, 10)}.tsv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setPending(false);
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={pending}>
      {pending ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />}
      Export
    </Button>
  );
}
