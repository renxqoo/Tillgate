/**
 * AdminStore port：管理员资料与授权策略的读写边界（G2——admin realm）。
 * 密码/会话凭据不在本 port（单一真相 = identity 七表,身份包迁移裁决 G1）;
 * 本 port 只承载「后台操作身份」资料：状态/角色/2FA 开关/最近登录。
 * 授权策略（status/role 判定）由消费方按词表语义裁决——port 不藏策略。
 */
import type { DbLike, DbTx } from '@tokenlens/db';
import type { AdminRole } from '../domain/rbac';

export interface AdminRecord {
  readonly id: number;
  readonly email: string;
  readonly displayName: string | null;
  /** ACCOUNT_STATUS 词表（0 正常 / 1 封禁 / 2 注注） */
  readonly status: number;
  /** RBAC 角色（封闭词表单一真相 = domain/rbac ADMIN_ROLES） */
  readonly role: AdminRole;
  readonly twoFactorEnabled: boolean;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
}

export interface CreateAdminRow {
  readonly email: string;
  readonly displayName: string | null;
  readonly role: AdminRole;
}

export interface UpdateAdminRow {
  readonly adminId: number;
  readonly displayName?: string | null;
  readonly role?: AdminRole;
  readonly status?: number;
}

export interface AdminStore {
  findById(db: DbLike, id: number): Promise<AdminRecord | null>;
  findByEmail(db: DbLike, email: string): Promise<AdminRecord | null>;
  /** 登录成功时间戳推进（SQL now()——多副本时钟纪律） */
  touchLastLogin(db: DbLike, id: number): Promise<void>;
  /** 邮箱验证码二次登录开关（SMTP 前置校验在 app 编排——port 不判 SMTP） */
  setTwoFactorEnabled(db: DbLike, input: { adminId: number; enabled: boolean }): Promise<void>;
  /** 管理面列表（id 升序;管理员数量级 < 100,不分页——DESIGN D7） */
  list(db: DbLike): Promise<AdminRecord[]>;
  /** 创建资料行（id ≥1e9 段分配与插入同事务——application 负责开事务;
   *  重名由 admins_email_uq 兜底,23505 由 application 翻译冲突） */
  create(db: DbTx, row: CreateAdminRow): Promise<AdminRecord>;
  /** 部分更新（未命中返回 null——admin_not_found 由 application 抛） */
  update(db: DbLike, row: UpdateAdminRow): Promise<AdminRecord | null>;
  /** 补偿删除（创建流程凭据注册失败时收回资料行——只此一个消费方） */
  remove(db: DbLike, adminId: number): Promise<void>;
}
