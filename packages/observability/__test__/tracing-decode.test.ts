import { describe, expect, it } from 'vitest';
import { decodeOtlpJson } from '../src/tracing/decode';
import { observabilityErrors } from '../src/errors';

/** 最小合法 OTLP/JSON ExportTraceServiceRequest 构造器(v1 otlp-decode.test 平移+边界补齐) */
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
  it('正常解码:属性提升列 + 时间换算 + 归一化', () => {
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

  it('status 枚举名与数值都接受;events 带时间归一', () => {
    const { rows } = decodeOtlpJson(
      wrap([
        otlpSpan({
          status: { code: 'STATUS_CODE_ERROR', message: 'upstream failed' },
          events: [{ name: 'exception', timeUnixNano: '1786718261500000000', attributes: [] }],
        }),
      ]),
    );
    expect(rows[0]!.statusCode).toBe(2);
    expect(rows[0]!.statusMessage).toBe('upstream failed');
    expect(rows[0]!.events).toHaveLength(1);
    expect(rows[0]!.events[0]!.timeMs).toBeGreaterThan(0);
  });

  it('嵌套值类型(array/kvlist)归一化', () => {
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
                    {
                      key: 'tags',
                      value: { arrayValue: { values: [{ stringValue: 'a' }, { intValue: 1 }] } },
                    },
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

  it('结构级错误抛目录码 observability.invalid_otlp_payload(G6:400 语义)', () => {
    for (const bad of [null, undefined, 'x', 42, {}, { resourceSpans: 'x' }]) {
      try {
        decodeOtlpJson(bad);
        expect.unreachable(`should throw for ${String(bad)}`);
      } catch (error) {
        expect(observabilityErrors.has((error as { code: string }).code)).toBe(true);
        expect((error as { code: string }).code).toBe('observability.invalid_otlp_payload');
      }
    }
  });

  it('单 span 畸形跳过并计数,不拖垮整批', () => {
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

  it('缺 service.name 兜底 unknown;parentSpanId 非 hex 置空', () => {
    const { rows } = decodeOtlpJson({
      resourceSpans: [
        { resource: {}, scopeSpans: [{ spans: [otlpSpan({ parentSpanId: 'zzz' })] }] },
      ],
    });
    expect(rows[0]!.service).toBe('unknown');
    expect(rows[0]!.parentSpanId).toBeNull();
  });

  // ---- B5 口径边界补齐(截断/提升列门与字面量语义)----

  it('提升列长度/类型门:requestId>64、channel>64、model>128 置 null;userId 非正整数置 null;别名键同判', () => {
    const { rows } = decodeOtlpJson(
      wrap([
        otlpSpan({
          attributes: [
            { key: 'request_id', value: { stringValue: 'x'.repeat(65) } },
            { key: 'userId', value: { stringValue: 'not-a-number' } },
            { key: 'channel', value: { stringValue: 'c'.repeat(65) } },
            { key: 'model', value: { stringValue: 'm'.repeat(129) } },
          ],
        }),
      ]),
    );
    expect(rows[0]!.requestId).toBeNull();
    expect(rows[0]!.userId).toBeNull();
    expect(rows[0]!.channel).toBeNull();
    expect(rows[0]!.model).toBeNull();
  });

  it('截断门:name>256 / statusMessage>512 / service>64 / event name>128 逐字段截断', () => {
    const { rows } = decodeOtlpJson({
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: 's'.repeat(70) } }],
          },
          scopeSpans: [
            {
              spans: [
                otlpSpan({
                  name: 'n'.repeat(300),
                  status: { code: 2, message: 'e'.repeat(600) },
                  events: [{ name: 'x'.repeat(200), timeUnixNano: '1786718261000000000' }],
                }),
              ],
            },
          ],
        },
      ],
    });
    expect(rows[0]!.name).toHaveLength(256);
    expect(rows[0]!.statusMessage).toHaveLength(512);
    expect(rows[0]!.service).toHaveLength(64);
    expect(rows[0]!.events[0]!.name).toHaveLength(128);
  });

  it('events 时间坏值回落 span startTime;非对象 resourceSpans 条目跳过计数', () => {
    const { rows, skipped } = decodeOtlpJson({
      resourceSpans: [
        'garbage',
        {
          resource: {},
          scopeSpans: [
            {
              spans: [
                otlpSpan({
                  events: [{ name: 'exception', timeUnixNano: 'not-a-number', attributes: [] }],
                }),
              ],
            },
          ],
        },
      ],
    });
    expect(skipped).toBe(1);
    expect(rows[0]!.events[0]!.timeMs).toBe(rows[0]!.startTime.getTime());
  });

  it('id 长度上限:traceId>32 / spanId>16 跳过', () => {
    const { rows, skipped } = decodeOtlpJson(
      wrap([otlpSpan({ traceId: 'a'.repeat(33) }), otlpSpan({ spanId: 'b'.repeat(17) })]),
    );
    expect(rows).toHaveLength(0);
    expect(skipped).toBe(2);
  });
});
