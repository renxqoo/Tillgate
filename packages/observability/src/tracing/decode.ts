import { observabilityErrors } from '../errors';
import type { SpanRow } from './types';

/**
 * OTLP/HTTP JSON(ExportTraceServiceRequest)→ SpanRow[]。
 *
 * 纯函数、无 IO:接收端调用;单测覆盖畸形输入。
 * 结构级错误(非对象/缺 resourceSpans)抛 `observability.invalid_otlp_payload`(400 语义,G6);
 * 单个 span 级畸形(非法 id/时间)跳过并计数(不因一条坏数据丢整批)。
 */

export interface DecodeResult {
  rows: SpanRow[];
  skipped: number;
}

interface OtlpAttribute {
  key: string;
  value?: Record<string, unknown>;
}

/** OTLP AnyValue 归一化为 JS 值(string/number/boolean/array/object) */
function decodeValue(value: Record<string, unknown> | undefined): unknown {
  if (!value || typeof value !== 'object') return undefined;
  if ('stringValue' in value) return value.stringValue as string;
  if ('boolValue' in value) return value.boolValue as boolean;
  if ('intValue' in value) return Number(value.intValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('bytesValue' in value) return value.bytesValue as string;
  if ('arrayValue' in value) {
    const arr = (value.arrayValue as { values?: Array<Record<string, unknown>> }).values ?? [];
    return arr.map((item) => decodeValue(item));
  }
  if ('kvlistValue' in value) {
    const kv = (value.kvlistValue as { values?: OtlpAttribute[] }).values ?? [];
    return Object.fromEntries(kv.map((item) => [item.key, decodeValue(item.value)]));
  }
  return undefined;
}

function attributesToRecord(list: OtlpAttribute[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const attr of list ?? []) {
    if (attr && typeof attr.key === 'string') out[attr.key] = decodeValue(attr.value);
  }
  return out;
}

const HEX_RE = /^[0-9a-f]+$/i;

function normalizeStatus(code: unknown): number {
  if (typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 2) return code;
  if (typeof code === 'string') {
    if (code.endsWith('UNSET')) return 0;
    if (code.endsWith('OK')) return 1;
    if (code.endsWith('ERROR')) return 2;
  }
  return 0;
}

function nanoToDate(value: unknown): Date | null {
  let nano = Number(value);
  if (typeof value === 'string') nano = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(nano) || nano <= 0) return null;
  return new Date(nano / 1_000_000);
}

/**
 * 领域属性提升:OTel attributes → 索引列(计费关联点查入口)。
 * 写侧长度门宽松(不丢合法数据);读侧点查另有 regex 白名单(防注入)——两道闸各司其职(B5 口径)。
 */
function promote(attrs: Record<string, unknown>): {
  requestId: string | null;
  userId: number | null;
  channel: string | null;
  model: string | null;
} {
  const rawRequestId = attrs['request.id'] ?? attrs['request_id'] ?? attrs['requestId'];
  const rawUserId = attrs['user.id'] ?? attrs['user_id'] ?? attrs['userId'];
  const rawChannel = attrs['channel.key'] ?? attrs['channel'];
  const rawModel = attrs['ai.model'] ?? attrs['model'];
  return {
    requestId: typeof rawRequestId === 'string' && rawRequestId.length <= 64 ? rawRequestId : null,
    userId:
      typeof rawUserId === 'number' && Number.isInteger(rawUserId) && rawUserId > 0
        ? rawUserId
        : null,
    channel: typeof rawChannel === 'string' && rawChannel.length <= 64 ? rawChannel : null,
    model: typeof rawModel === 'string' && rawModel.length <= 128 ? rawModel : null,
  };
}

interface OtlpSpan {
  traceId?: unknown;
  spanId?: unknown;
  parentSpanId?: unknown;
  name?: unknown;
  startTimeUnixNano?: unknown;
  endTimeUnixNano?: unknown;
  attributes?: OtlpAttribute[];
  status?: { code?: unknown; message?: unknown };
  events?: Array<{ name?: unknown; timeUnixNano?: unknown; attributes?: OtlpAttribute[] }>;
}

export function decodeOtlpJson(body: unknown): DecodeResult {
  if (typeof body !== 'object' || body === null) {
    throw observabilityErrors.business('invalid_otlp_payload', {
      reason: 'payload is not a JSON object',
    });
  }
  const resourceSpans = (body as { resourceSpans?: unknown }).resourceSpans;
  if (!Array.isArray(resourceSpans)) {
    throw observabilityErrors.business('invalid_otlp_payload', {
      reason: 'missing the resourceSpans array',
    });
  }

  const rows: SpanRow[] = [];
  let skipped = 0;

  for (const rs of resourceSpans) {
    if (typeof rs !== 'object' || rs === null) {
      skipped += 1;
      continue;
    }
    const resource = (rs as { resource?: { attributes?: OtlpAttribute[] } }).resource;
    const resourceAttrs = attributesToRecord(resource?.attributes);
    const service =
      typeof resourceAttrs['service.name'] === 'string' && resourceAttrs['service.name']
        ? (resourceAttrs['service.name'] as string).slice(0, 64)
        : 'unknown';

    const scopeSpans = (rs as { scopeSpans?: unknown }).scopeSpans;
    if (!Array.isArray(scopeSpans)) continue;

    for (const ss of scopeSpans) {
      const spans =
        typeof ss === 'object' && ss !== null ? (ss as { spans?: unknown }).spans : null;
      if (!Array.isArray(spans)) continue;

      for (const raw of spans) {
        const span = raw as OtlpSpan;
        const traceId = typeof span.traceId === 'string' ? span.traceId : '';
        const spanId = typeof span.spanId === 'string' ? span.spanId : '';
        const name = typeof span.name === 'string' ? span.name : '';
        if (
          !HEX_RE.test(traceId) ||
          traceId.length > 32 ||
          !HEX_RE.test(spanId) ||
          spanId.length > 16 ||
          !name
        ) {
          skipped += 1;
          continue;
        }
        const startTime = nanoToDate(span.startTimeUnixNano);
        const endTime = nanoToDate(span.endTimeUnixNano);
        if (!startTime || !endTime || endTime < startTime) {
          skipped += 1;
          continue;
        }
        const attributes = attributesToRecord(span.attributes);
        rows.push({
          traceId,
          spanId,
          parentSpanId:
            typeof span.parentSpanId === 'string' && HEX_RE.test(span.parentSpanId)
              ? span.parentSpanId
              : null,
          name: name.slice(0, 256),
          service,
          startTime,
          endTime,
          durationMs: endTime.getTime() - startTime.getTime(),
          statusCode: normalizeStatus(span.status?.code),
          statusMessage:
            typeof span.status?.message === 'string' ? span.status.message.slice(0, 512) : null,
          ...promote(attributes),
          attributes,
          events: (span.events ?? [])
            .filter((e) => typeof e?.name === 'string')
            .map((e) => ({
              name: (e.name as string).slice(0, 128),
              timeMs: nanoToDate(e.timeUnixNano)?.getTime() ?? startTime.getTime(),
              attributes: attributesToRecord(e.attributes),
            })),
        });
      }
    }
  }
  return { rows, skipped };
}
