'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useTranslations } from 'next-intl';

import type { GraphNode } from './graph';

function spanKindIcon(kind: GraphNode['kind']): string {
  const icons: Partial<Record<GraphNode['kind'], string>> = {
    http: '🌐',
    upstream: '🔀',
    stream: '📡',
    billing: '💰',
    settle: '🧾',
  };
  return icons[kind] ?? '⚙️';
}

function spanTone(node: GraphNode): string {
  if (node.status === 'error') return 'border-destructive/70 bg-destructive/10 animate-pulse';
  if (node.status === 'ok') return 'border-emerald-600/40 bg-emerald-500/5';
  if (node.kind === 'billing') return 'border-sky-600/40 bg-sky-500/5';
  if (node.kind === 'settle') return 'border-violet-600/40 bg-violet-500/5';
  return 'border-border bg-background';
}

/** 语义节点卡片（kind 决定图标与配色；错误红框脉动） */
export function SpanCard({ data }: NodeProps) {
  const t = useTranslations('tracing');
  const node = data.graphNode as GraphNode;
  const isError = node.status === 'error';
  const icon = spanKindIcon(node.kind);
  // 计费节点默认蓝调（金额语义），结算成功绿调
  const tone = spanTone(node);
  return (
    <div className={`w-[230px] rounded-lg border-2 px-3 py-2 shadow-sm transition-colors ${tone}`}>
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground" />
      <div className="flex items-center gap-2">
        <span>{icon}</span>
        <span className="truncate text-xs font-semibold" title={node.title}>
          {node.title}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <span
            className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground"
            title={t('stepTitle')}
          >
            {t('stepNo', { n: node.step })}
          </span>
          {node.attempt != null && node.attempt > 1 ? (
            <span className="rounded bg-amber-500/15 px-1.5 text-[10px] text-amber-600">
              {t('attemptNo', { n: node.attempt })}
            </span>
          ) : null}
        </span>
      </div>
      {node.subtitle ? (
        <div className="mt-1 truncate text-[11px] text-muted-foreground" title={node.subtitle}>
          {node.subtitle}
        </div>
      ) : null}
      <div className="mt-1 flex items-center justify-between text-[11px]">
        <span className="tabular-nums text-muted-foreground">{node.durationMs} ms</span>
        {isError ? (
          <span className="max-w-36 truncate text-destructive" title={node.errorText ?? ''}>
            ❌ {node.errorText ?? 'error'}
          </span>
        ) : (
          <span className="text-emerald-600">✓</span>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-muted-foreground" />
    </div>
  );
}
