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

/** string 提取门:是 string 且不超 maxLen 才收,否则 null */
function pickString(value: unknown, maxLen: number): string | null {
  return typeof value === 'string' && value.length <= maxLen ? value : null;
}

/** 正整数提取门(用户 id 不收 0/负数/小数) */
function pickPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function promote(attrs: Record<string, unknown>): {
  requestId: string | null;
  userId: number | null;
  channel: string | null;
  model: string | null;
} {
  return {
    requestId: pickString(attrs['request.id'] ?? attrs['request_id'] ?? attrs['requestId'], 64),
    userId: pickPositiveInt(attrs['user.id'] ?? attrs['user_id'] ?? attrs['userId']),
    channel: pickString(attrs['channel.key'] ?? attrs['channel'], 64),
    model: pickString(attrs['ai.model'] ?? attrs['model'], 128),
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

/** id/name 三元组收窄:任一不过 hex/长度/非空门返回 null */
function spanIdentity(span: OtlpSpan): { traceId: string; spanId: string; name: string } | null {
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
    return null;
  }
  return { traceId, spanId, name };
}

/** 起止时间收窄:坏值或 end < start 返回 null */
function spanWindow(span: OtlpSpan): { startTime: Date; endTime: Date } | null {
  const startTime = nanoToDate(span.startTimeUnixNano);
  const endTime = nanoToDate(span.endTimeUnixNano);
  if (!startTime || !endTime || endTime < startTime) {
    return null;
  }
  return { startTime, endTime };
}

/** 单 span → SpanRow;形状/时间门不过返回 null(由调用方计数跳过,不丢整批) */
function spanToRow(span: OtlpSpan, service: string): SpanRow | null {
  const identity = spanIdentity(span);
  if (identity === null) return null;
  const window = spanWindow(span);
  if (window === null) return null;
  const { traceId, spanId, name } = identity;
  const { startTime, endTime } = window;
  const attributes = attributesToRecord(span.attributes);
  return {
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
  };
}

/** resourceSpans 条目 → 归一 service 名(缺 service.name 兜底 unknown,截断 64) */
function serviceNameOf(rs: object): string {
  const { resource } = rs as { resource?: { attributes?: OtlpAttribute[] } };
  const resourceAttrs = attributesToRecord(resource?.attributes);
  const raw = resourceAttrs['service.name'];
  return typeof raw === 'string' && raw ? raw.slice(0, 64) : 'unknown';
}

export function decodeOtlpJson(body: unknown): DecodeResult {
  if (typeof body !== 'object' || body === null) {
    throw observabilityErrors.business('invalid_otlp_payload', {
      reason: 'payload is not a JSON object',
    });
  }
  const { resourceSpans } = body as { resourceSpans?: unknown };
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
    const service = serviceNameOf(rs);

    const { scopeSpans } = rs as { scopeSpans?: unknown };
    if (!Array.isArray(scopeSpans)) continue;

    for (const ss of scopeSpans) {
      const spans =
        typeof ss === 'object' && ss !== null ? (ss as { spans?: unknown }).spans : null;
      if (!Array.isArray(spans)) continue;

      for (const raw of spans) {
        const row = spanToRow(raw as OtlpSpan, service);
        if (row === null) {
          skipped += 1;
          continue;
        }
        rows.push(row);
      }
    }
  }
  return { rows, skipped };
}
