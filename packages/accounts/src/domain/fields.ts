/**
 * 字段域规则:email/displayName/name/remark 等文本字段与限额数值的纯校验。
 * 宽度常量是 DDL varchar 的契约镜像(db schema 为物理真相,变更须与迁移同拍),
 * 不作装配旋钮;可变阈值(金额上界/频率上界)由 policy 必填注入(铁律 3)。
 */

/** DDL varchar 宽度镜像(users/organizations/api_keys/apps/org_invitations/referrals) */
export const FIELD_LIMITS = {
  email: 255,
  displayName: 64,
  name: 64,
  remark: 255,
  description: 255,
  freezeReason: 128,
  affCode: 32,
  token: 64,
  modelId: 64,
} as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** email 规范化:trim + 小写(v1 登录/注册口径;唯一索引按规范化值命中,消灭大小写分叉) */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(normalized: string): boolean {
  return (
    normalized.length >= 3 && normalized.length <= FIELD_LIMITS.email && EMAIL_RE.test(normalized)
  );
}

/** 校验并规范化;不合法返回 null(调用方翻译 email_invalid) */
export function normalizeValidEmail(email: string): string | null {
  const normalized = normalizeEmail(email);
  return isValidEmail(normalized) ? normalized : null;
}

/** 通用命名域:trim 后 1..64(用户显示名/Key 名/App 名/组织名共用) */
export function normalizeName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > FIELD_LIMITS.name) return null;
  return trimmed;
}

/**
 * 可空文本清洗(仅处理字符串输入;显式 null 清空由调用方先行分支):
 * trim 后 ≤ max 返回清洗值,超长返回 null 表示「非法」。
 */
export function clampOptionalText(text: string, max: number): string | null {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : null;
}
