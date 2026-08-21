/**
 * 包内私有工具（不进公共出口 src/index.ts）
 * 命名空间 `internal/` 与 errors/internal.ts 一致：表示包内部实现细节，可随时变更。
 */

/** 安全地把 unknown 收敛为 Record（非对象/数组返回 null） */
export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/** 安全地把 unknown 收敛为数组（非数组返回 null） */
export function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

/** 容错 JSON.parse：失败返回 undefined（不抛） */
export function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
