import { describe, expect, it } from 'vitest';
import { decodeOtlpJson, DecodeError } from '../otlp-decode.js';

/** 最小合法 OTLP/JSON ExportTraceServiceRequest 构造器 */
function otlpSpan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    name: 'POST /v1/chat/completions',
    startTimeUnixNano: '1786718261000000000',
    endTimeUnixNano: '1786718263000000000',
    attributes: [
      { key: 'request.id', value: { stringValue: 'req-abc-123' } },
      { key: 'user.id', value: { intValue: 42 } },
      { key: 'channel.key', value: { stringValue: 'ch-main' } },
      { key: 'ai.model', value: { stringValue: 'deepseek-chat' } },
      { key: 'http.status_code', value: { intValue: 200 } },
    ],
    status: { code: 1 },
    ...overrides,
  };
}

function wrap(spans: Array<Record<string, unknown>>, service = 'gateway'): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
        scopeSpans: [{ spans }],
      },
    ],
  };
}

describe('decodeOtlpJson', () => {
  it('正常解码：属性提升列 + 时间换算 + 归一化', () => {
    const { rows, skipped } = decodeOtlpJson(wrap([otlpSpan()]));
    expect(skipped).toBe(0);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.service).toBe('gateway');
    expect(row.requestId).toBe('req-abc-123');
    expect(row.userId).toBe(42);
    expect(row.channel).toBe('ch-main');
    expect(row.model).toBe('deepseek-chat');
    expect(row.durationMs).toBe(2000);
    expect(row.statusCode).toBe(1);
    expect(row.attributes['http.status_code']).toBe(200);
  });

  it('status 枚举名与数值都接受；events 带时间归一', () => {
    const { rows } = decodeOtlpJson(
      wrap([
        otlpSpan({
          status: { code: 'STATUS_CODE_ERROR', message: 'upstream failed' },
          events: [
            { name: 'exception', timeUnixNano: '1786718261500000000', attributes: [] },
          ],
        }),
      ]),
    );
    expect(rows[0]!.statusCode).toBe(2);
    expect(rows[0]!.statusMessage).toBe('upstream failed');
    expect(rows[0]!.events).toHaveLength(1);
    expect(rows[0]!.events[0]!.timeMs).toBeGreaterThan(0);
  });

  it('嵌套值类型（array/kvlist）归一化', () => {
    const { rows } = decodeOtlpJson(
      wrap([
        otlpSpan({
          attributes: [
            {
              key: 'dims',
              value: {
                kvlistValue: {
                  values: [
                    { key: 'region', value: { stringValue: 'cn' } },
                    { key: 'tags', value: { arrayValue: { values: [{ stringValue: 'a' }, { intValue: 1 }] } } },
                  ],
                },
              },
            },
          ],
        }),
      ]),
    );
    expect(rows[0]!.attributes['dims']).toEqual({ region: 'cn', tags: ['a', 1] });
  });

  it('结构级错误抛 DecodeError（400 语义）', () => {
    expect(() => decodeOtlpJson(null)).toThrow(DecodeError);
    expect(() => decodeOtlpJson({})).toThrow(DecodeError);
    expect(() => decodeOtlpJson({ resourceSpans: 'x' })).toThrow(DecodeError);
  });

  it('单 span 畸形跳过并计数，不拖垮整批', () => {
    const { rows, skipped } = decodeOtlpJson(
      wrap([
        otlpSpan({ traceId: 'not-hex!!' }),
        otlpSpan({ startTimeUnixNano: 'abc' }),
        otlpSpan({ endTimeUnixNano: '1786718260000000000' }), // end < start
        otlpSpan(), // 合法
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(skipped).toBe(3);
  });

  it('缺 service.name 兜底 unknown；parentSpanId 非 hex 置空', () => {
    const { rows } = decodeOtlpJson({
      resourceSpans: [
        { resource: {}, scopeSpans: [{ spans: [otlpSpan({ parentSpanId: 'zzz' })] }] },
      ],
    });
    expect(rows[0]!.service).toBe('unknown');
    expect(rows[0]!.parentSpanId).toBeNull();
  });
});
