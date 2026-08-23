/**
 * 观测域 presenter：audit/requestLog 行 → wire 行。
 * wire 偏差（MIGRATION §4 D5）：adminSubject 无 join 来源恒 null;
 * 日志行无 apiKeyId/attempts 列来源（apiKeyId 补 null,attempts 不输出）。
 */
import { iso } from '../contracts/common';

export interface AuditRowSource {
  readonly id: number;
  readonly adminId: number | null;
  readonly actor: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly detail: unknown;
  readonly createdAt: Date;
}

export function toAuditWireRow(row: AuditRowSource) {
  return {
    id: row.id,
    adminId: row.adminId,
    actor: row.actor,
    adminSubject: null,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    detail: (row.detail ?? null) as Record<string, unknown> | string | null,
    createdAt: iso(row.createdAt)!,
  };
}

export interface RequestLogRowSource {
  readonly id: number;
  readonly requestId: string;
  readonly userId: number | null;
  readonly userName: string | null;
  readonly method: string;
  readonly path: string;
  readonly statusCode: number;
  readonly errorCode: string | null;
  readonly sourceIp: string | null;
  readonly durationMs: number;
  readonly requestSummary: Record<string, unknown> | null;
  readonly createdAt: Date;
}

export function toRequestLogWireRow(row: RequestLogRowSource) {
  return {
    id: row.id,
    requestId: row.requestId,
    userId: row.userId,
    userName: row.userName,
    apiKeyId: null,
    method: row.method,
    path: row.path,
    statusCode: row.statusCode,
    errorCode: row.errorCode,
    durationMs: row.durationMs,
    requestSummary: row.requestSummary,
    sourceIp: row.sourceIp,
    createdAt: iso(row.createdAt)!,
  };
}
