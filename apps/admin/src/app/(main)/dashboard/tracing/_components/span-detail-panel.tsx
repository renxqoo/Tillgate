'use client';

/** span 属性详情侧栏：路线图节点点击与瀑布行点击共用（单一展示真相） */
export function SpanDetailPanel({
  span,
  onClose,
}: {
  span: {
    spanId: string;
    parentSpanId: string | null;
    name: string;
    service: string;
    startTime: string;
    endTime: string;
    durationMs: number;
    statusCode: number;
    statusMessage: string | null;
    requestId: string | null;
    channel: string | null;
    model: string | null;
    attributes: Record<string, unknown>;
  };
  onClose: () => void;
}) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3 text-xs">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="font-medium">{span.name}</div>
          <div className="text-muted-foreground">
            {span.service} · {span.durationMs}ms ·{' '}
            {span.statusCode === 2 ? (
              <span className="text-destructive">ERROR {span.statusMessage ?? ''}</span>
            ) : (
              `status ${span.statusCode}`
            )}
          </div>
        </div>
        <button type="button" onClick={onClose} className="rounded px-2 py-1 hover:bg-muted">
          关闭
        </button>
      </div>
      <pre className="max-h-72 overflow-auto rounded bg-muted p-2 text-[11px] leading-relaxed">
        {JSON.stringify(
          {
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            requestId: span.requestId,
            channel: span.channel,
            model: span.model,
            window: [span.startTime, span.endTime],
            attributes: span.attributes,
          },
          null,
          2,
        )}
      </pre>
    </div>
  );
}
