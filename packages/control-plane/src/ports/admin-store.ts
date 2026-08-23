/**
 * AdminStore port：管理员资料与授权策略的读写边界（G2——admin realm）。
 * 密码/会话凭据不在本 port（单一真相 = identity 七表,身份包迁移裁决 G1）;
 * 本 port 只承载「后台操作身份」资料：状态/2FA 开关/最近登录。
 * 授权策略（status 判定）由消费方按 ACCOUNT_STATUS 语义裁决——port 不藏策略。
 */
import type { DbLike } from '@tokenlens/db';

export interface AdminRecord {
  readonly id: number;
  readonly email: string;
  readonly displayName: string | null;
  /** ACCOUNT_STATUS 词表（0 正常 / 1 封禁 / 2 注注） */
  readonly status: number;
  readonly twoFactorEnabled: boolean;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
}

export interface AdminStore {
  findById(db: DbLike, id: number): Promise<AdminRecord | null>;
  findByEmail(db: DbLike, email: string): Promise<AdminRecord | null>;
  /** 登录成功时间戳推进（SQL now()——多副本时钟纪律） */
  touchLastLogin(db: DbLike, id: number): Promise<void>;
  /** 邮箱验证码二次登录开关（SMTP 前置校验在 app 编排——port 不判 SMTP） */
  setTwoFactorEnabled(db: DbLike, input: { adminId: number; enabled: boolean }): Promise<void>;
}
