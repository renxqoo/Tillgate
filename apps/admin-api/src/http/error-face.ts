/**
 * 错误面装配（v1 error-map.ts 的目录体系替身——E1/E3 病灶核销）：
 * 全量目录合成（http + 六能力包 + app 自有 admin.*），路由只抛目录业务错误,
 * errorHandler 按 nature/category 分派渲染,PG SQLSTATE 仅兜底注入。
 * message 英文(铁律 18),中文经目录 zh 字段按 Accept-Language 协商。
 */
import { composeErrorCatalogs } from '@tillgate/errors';
import { HttpErrors, type FaceOverride } from '@tillgate/http';
import { AccountsErrors } from '@tillgate/accounts';
import { controlPlaneErrors } from '@tillgate/control-plane';
import { BillingErrors } from '@tillgate/billing';
import { observabilityErrors } from '@tillgate/observability';
import { identityErrors } from '@tillgate/identity';
import { notificationsErrors } from '@tillgate/notifications';
import { defineErrorCatalog } from '@tillgate/errors';

/** app 自有目录 admin.*：只登记 app 协议层抛点的边界码（铁律 4：无抛点不登记） */
export const AdminErrors = defineErrorCatalog('admin', {
  invalid_param: {
    category: 'invalid_input',
    message: 'Invalid request parameter',
    zh: '请求参数无效',
  },
  invalid_sort_field: {
    category: 'invalid_input',
    message: 'Unsupported sort field',
    zh: '不支持的排序字段',
  },
  /** 目录源路径参数未知（v1 catalog_source_not_found 语义;404 不泄漏源清单） */
  catalog_source_not_found: {
    category: 'not_found',
    message: 'Unknown catalog source',
    zh: '未知的目录源',
  },
  /** 进货凭证键不存在/非法（v1 voucher_not_found;404 不泄漏存储布局） */
  voucher_not_found: {
    category: 'not_found',
    message: 'Voucher not found',
    zh: '凭证不存在',
  },
  // ---- P2 登录面（v1 auth.service AppError 码平移）----
  /** 管理员凭据不匹配（与 identity.invalid_credentials 区分:凭据行存在但资料行漂移） */
  invalid_credentials_admin: {
    category: 'invalid_input',
    message: 'Invalid email or password',
    zh: '邮箱或密码错误',
  },
  /** 爆破守卫（Redis）不可达——fail-closed,不静默降级为无锁 */
  auth_guard_unavailable: {
    category: 'unavailable',
    message: 'Auth guard unavailable, please try again later',
    zh: '登录防护暂不可用，请稍后重试',
  },
  /** 爆破锁定（(email,ip) 键或 IP 维度;正确密码路径已在锁前放行） */
  login_locked: {
    category: 'rate_limited',
    message: 'Too many attempts, please try again later',
    zh: '尝试次数过多，请稍后重试',
  },
  /** 账号不可用（封禁/注销——登录期 403;会话期归 401 属主回查） */
  account_unavailable: {
    category: 'forbidden',
    message: 'Account unavailable',
    zh: '账号不可用',
  },
  /** 2FA 需要邮箱验证码但 SMTP 未配置——绝不静默降级单密码 */
  two_factor_unavailable: {
    category: 'unavailable',
    message: 'Email verification code required but SMTP is not configured',
    zh: '需要邮箱验证码但 SMTP 未配置',
  },
  /** 开启 2FA 前置 SMTP 未配置（与 two_factor_unavailable 分列:前置校验 400） */
  smtp_not_configured: {
    category: 'invalid_input',
    message: 'Enabling two-factor authentication requires SMTP configuration first',
    zh: '开启两步验证需先配置 SMTP',
  },
  /** TOTP 解绑码无效（验证器/恢复码都不匹配） */
  invalid_totp_code: {
    category: 'invalid_input',
    message: 'Invalid authenticator or recovery code',
    zh: '验证器或恢复码不正确',
  },
  /** 会话有效但管理员资料行缺失（迁移不完整） */
  admin_not_found: {
    category: 'not_found',
    message: 'Admin not found',
    zh: '管理员不存在',
  },
  // ---- RBAC（docs/admin-rbac/DESIGN.md §2.5）----
  /** 会话有效但角色无该权限（词表/矩阵单一真相 = control-plane domain/rbac） */
  insufficient_permission: {
    category: 'forbidden',
    message: 'Insufficient permission for this operation',
    zh: '当前角色无权执行该操作',
  },
  /** 接口未绑定权限（全局 ACL fail-closed——除超管外全拒,补配绑定即恢复） */
  endpoint_unbound: {
    category: 'forbidden',
    message: 'Endpoint has no permission binding',
    zh: '接口未绑定权限（默认拒绝）',
  },
  /** 修改自身 role/status 被拒（防最后一个超管自锁——DESIGN D6;displayName 可改） */
  cannot_modify_self: {
    category: 'invalid_input',
    message: 'Admins cannot modify their own role or status',
    zh: '不能修改自己的角色或状态',
  },
  /** 只能为本地账号设密——给 OIDC 身份挂本地密码 = 管理员接管（D6） */
  not_local_account: {
    category: 'invalid_input',
    message: 'Password can only be set for local accounts',
    zh: '只能为本地账号设置密码',
  },
});

/** 全量目录(app 唯一错误事实源;handler 渲染与测试断言共用) */
export const adminErrorCatalog = composeErrorCatalogs(
  HttpErrors,
  AccountsErrors,
  controlPlaneErrors,
  BillingErrors,
  observabilityErrors,
  identityErrors,
  notificationsErrors,
  AdminErrors,
);

/** 状态钉死表:P2 登录面 v1 wire 语义与 category 默认不同的条目（client-api 同机制） */
export const ADMIN_FACE_OVERRIDES: Readonly<Record<string, FaceOverride>> = {
  // 防枚举统一 401（v1 语义;identity 目录 category 默认 403）
  'identity.invalid_credentials': { status: 401 },
  // 凭据行与资料行漂移——同口径 401（category 默认 400）
  'admin.invalid_credentials_admin': { status: 401 },
};
