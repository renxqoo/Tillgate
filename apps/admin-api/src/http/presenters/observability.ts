/**
 * 观测域 presenter：audit/requestLog 行 → wire 行。
 * adminSubject 无 join 来源恒 null;
 * 日志行无 apiKeyId 列来源（apiKeyId 补 null）。
 */
import { isoRequired } from '../contracts/common';

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
    createdAt: isoRequired(row.createdAt),
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
  readonly attempts: number;
  readonly channels: string[] | null;
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
    attempts: row.attempts,
    channels: row.channels,
    sourceIp: row.sourceIp,
    createdAt: isoRequired(row.createdAt),
  };
}
