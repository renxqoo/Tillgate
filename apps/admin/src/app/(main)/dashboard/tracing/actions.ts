'use server';

import { getTranslations } from 'next-intl/server';

import { ApiError, adminFetch } from '@ai-gateway/api-client';

export interface TraceDetail {
  spans: Array<{
    traceId: string;
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
  }>;
  services: string[];
  startMs: number;
  durationMs: number;
}

/** 弹窗懒加载单 trace 详情（server action 转发管理员会话到 admin-api） */
export async function fetchTraceDetail(traceId: string): Promise<TraceDetail | { error: string }> {
  const t = await getTranslations('tracing');
  const tc = await getTranslations('common');
  if (!/^[0-9a-f]{1,32}$/i.test(traceId)) return { error: t('invalidTraceId') };
  try {
    return await adminFetch<TraceDetail>(`/v1/tracing/traces/${traceId}`);
  } catch (caught) {
    return { error: caught instanceof ApiError ? caught.message : tc('loadFailed') };
  }
}

/** 按 request_id 懒加载关联 trace（计费复核「查链路」入口），响应与 trace 详情同形状 */
export async function fetchTraceDetailByRequestId(
  requestId: string,
): Promise<TraceDetail | { error: string }> {
  const t = await getTranslations('tracing');
  const tc = await getTranslations('common');
  if (!/^[0-9a-zA-Z-]{1,64}$/.test(requestId)) return { error: t('invalidRequestId') };
  try {
    return await adminFetch<TraceDetail>(`/v1/tracing/by-request/${requestId}`);
  } catch (caught) {
    return { error: caught instanceof ApiError ? caught.message : tc('loadFailed') };
  }
}
