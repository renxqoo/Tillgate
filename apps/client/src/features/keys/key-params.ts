/**
 * Key 限额表单参数解析（纯函数，可测）：
 * RPM/TPM 留空=不限、填值须正整数；每日花费上限留空=不限、须非负十进制。
 */
export type IntParseResult = { ok: true; value: number | null } | { ok: false; message: string };
export type MoneyParseResult = { ok: true; value: string | null } | { ok: false; message: string };

export function parsePositiveInt(raw: string | undefined, invalidMessage: string): IntParseResult {
  if (raw === undefined || raw.trim() === '') return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    return { ok: false, message: invalidMessage };
  }
  return { ok: true, value: n };
}

export function parseDailySpend(raw: string | undefined, invalidMessage: string): MoneyParseResult {
  if (raw === undefined || raw.trim() === '') return { ok: true, value: null };
  const value = raw.trim();
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    return { ok: false, message: invalidMessage };
  }
  return { ok: true, value };
}
