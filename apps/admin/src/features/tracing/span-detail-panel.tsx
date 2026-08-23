'use client';

import { useTranslations } from 'next-intl';

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
  const t = useTranslations('tracing');
  const tc = useTranslations('common');
  const chips = summarizeBilling(span.attributes, t);
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
          {tc('close')}
        </button>
      </div>
      {chips ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <span
              key={chip.label}
              className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[11px] text-sky-700 dark:text-sky-400"
              title={chip.title}
            >
              {chip.label}
            </span>
          ))}
        </div>
      ) : null}
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

/** 金额 chip 文案（元，string 金额直接拼接展示，不做数值转换） */
function fmtAmount(v: unknown): string {
  return `¥${v}`;
}

/** token 千分位（数字才格式化，其他原样） */
function fmtTokens(v: unknown): string {
  return typeof v === 'number' ? v.toLocaleString('en-US') : String(v);
}

/**
 * 计费相关属性的友好摘要（金额/ token 千分位）：
 * billing.* / usage.* 存在时渲染 chips，一眼看金额与用量，细节仍看原始 JSON。
 */
function summarizeBilling(
  attrs: Record<string, unknown>,
  t: ReturnType<typeof useTranslations<'tracing'>>,
): Array<{ label: string; title?: string }> | null {
  const chips: Array<{ label: string; title?: string }> = [];

  const settledAmount = attrs['billing.amount'];
  if (typeof settledAmount === 'string' && settledAmount !== '') {
    chips.push({
      label: t('settled', { amount: fmtAmount(settledAmount) }),
      title: t('settledTitle'),
    });
  }
  const reserved = attrs['billing.amount_reserved'];
  if (typeof reserved === 'string' && reserved !== '') {
    chips.push({
      label: t('reservedAuth', { amount: fmtAmount(reserved) }),
      title: t('reservedTitle'),
    });
  }
  const required = attrs['billing.amount_required'];
  if (typeof required === 'string' && required !== '') {
    chips.push({
      label: t('estimatedRequired', { amount: fmtAmount(required) }),
      title: 'billing.amount_required',
    });
  }
  const input = attrs['usage.input_tokens'];
  const cached = attrs['usage.cached_input_tokens'];
  const output = attrs['usage.output_tokens'];
  if (typeof input === 'number' || typeof output === 'number') {
    chips.push({
      label: `in ${fmtTokens(input ?? 0)}${typeof cached === 'number' && cached > 0 ? ` (cache ${fmtTokens(cached)})` : ''} / out ${fmtTokens(output ?? 0)} tok`,
      title: 'usage.*_tokens',
    });
  }
  const state = attrs['billing.state'] ?? attrs['billing.finalize'];
  if (typeof state === 'string' && state !== '') {
    chips.push({ label: `state: ${state}`, title: 'billing.state' });
  }
  const reject = attrs['billing.reject_code'];
  if (typeof reject === 'string' && reject !== '') {
    chips.push({ label: t('rejected', { code: reject }), title: 'billing.reject_code' });
  }
  const ttfb = attrs['upstream.ttfb_ms'] ?? attrs['stream.ttfb_ms'];
  if (typeof ttfb === 'number') {
    chips.push({
      label: `TTFB ${ttfb} ms`,
      title: t('ttfbTitle'),
    });
  }
  const terminated = attrs['stream.terminated'];
  if (typeof terminated === 'string' && terminated !== '') {
    chips.push({ label: t('terminated', { reason: terminated }), title: t('terminatedTitle') });
  }
  return chips.length > 0 ? chips : null;
}
