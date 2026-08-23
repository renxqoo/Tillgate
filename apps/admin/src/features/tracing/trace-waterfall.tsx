'use client';

import { useState } from 'react';
import { SpanDetailPanel } from './span-detail-panel';

interface SpanRow {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  service: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  statusCode: number;
  statusMessage: string | null;
  channel: string | null;
  model: string | null;
  attributes: Record<string, unknown>;
  traceId: string;
  requestId: string | null;
}

/** 瀑布图：条形按 trace 起点归一化；点击展开属性面板（与路线图共用 SpanDetailPanel） */
export function TraceWaterfall({
  spans,
  startMs,
  totalMs,
  heightClass = '',
}: {
  spans: SpanRow[];
  startMs: number;
  totalMs: number;
  /** 容器限高（弹窗全屏时传值；默认不限） */
  heightClass?: string;
}) {
  const [openSpan, setOpenSpan] = useState<string | null>(null);
  const selected = spans.find((s) => s.spanId === openSpan) ?? null;
  const sorted = spans.toSorted(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
  );

  return (
    <div className={`flex flex-col gap-1 ${heightClass} overflow-auto`}>
      {sorted.map((span) => {
        const offset = new Date(span.startTime).getTime() - startMs;
        const left = totalMs > 0 ? (offset / totalMs) * 100 : 0;
        const width = totalMs > 0 ? Math.max(0.5, (span.durationMs / totalMs) * 100) : 0;
        const isError = span.statusCode === 2;
        return (
          <div key={span.spanId} className="text-xs">
            <button
              type="button"
              onClick={() => setOpenSpan(openSpan === span.spanId ? null : span.spanId)}
              className="flex w-full items-center gap-2 rounded px-1 py-0.5 hover:bg-muted"
            >
              <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
                {span.durationMs}ms
              </span>
              <span className="relative h-4 w-full min-w-40 overflow-hidden rounded bg-muted/40">
                <span
                  className={`absolute inset-y-0 rounded ${isError ? 'bg-destructive/70' : 'bg-primary/60'}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              </span>
              <span className="w-56 shrink-0 truncate text-left font-medium">{span.name}</span>
              <span className="shrink-0 text-muted-foreground">
                {span.service}
                {span.channel ? ` · ${span.channel}` : ''}
                {span.model ? ` · ${span.model}` : ''}
              </span>
            </button>
          </div>
        );
      })}
      {selected ? <SpanDetailPanel span={selected} onClose={() => setOpenSpan(null)} /> : null}
    </div>
  );
}
