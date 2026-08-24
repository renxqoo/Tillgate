/**
 * AdminStore port：管理员资料与授权策略的读写边界（G2——admin realm）。
 * 密码/会话凭据不在本 port（单一真相 = identity 七表,身份包迁移裁决 G1）;
 * 本 port 只承载「后台操作身份」资料：状态/角色/2FA 开关/最近登录。
 * 授权策略（status/role 判定）由消费方按词表语义裁决——port 不藏策略。
 */
import type { DbLike, DbTx } from '@tokenlens/db';
import type { AdminAccess } from '../domain/rbac';

export interface AdminRecord {
  readonly id: number;
  readonly email: string;
  readonly displayName: string | null;
  /** ACCOUNT_STATUS 词表（0 正常 / 1 封禁 / 2 注注） */
  readonly status: number;
  /** 角色 FK（roles.id） */
  readonly roleId: number;
  /** 角色 code（join roles——v2 切换期旧执法链消费;切换后仅供展示） */
  readonly role: string;
  readonly twoFactorEnabled: boolean;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
}

export interface CreateAdminRow {
  readonly email: string;
  readonly displayName: string | null;
  readonly roleId: number;
}

export interface UpdateAdminRow {
  readonly adminId: number;
  readonly displayName?: string | null;
  readonly roleId?: number;
  readonly status?: number;
}

/** 管理面列表查询（统一列表契约的 store 投影;q 匹配 email/displayName 前后缀） */
export interface AdminListQuery {
  readonly q?: string;
  readonly sortBy: 'id' | 'email' | 'lastLoginAt' | 'createdAt';
  readonly order: 'asc' | 'desc';
  readonly limit: number;
  readonly offset: number;
}

export interface AdminListResult {
  readonly rows: AdminRecord[];
  readonly total: number;
}

export interface AdminStore {
  findById(db: DbLike, id: number): Promise<AdminRecord | null>;
  findByEmail(db: DbLike, email: string): Promise<AdminRecord | null>;
  /** v2 属主回查完整面（一条 join:状态 + isSuper + active 码集合;不存在 → null） */
  findAccess(db: DbLike, adminId: number): Promise<AdminAccess | null>;
  /** 登录成功时间戳推进（SQL now()——多副本时钟纪律） */
  touchLastLogin(db: DbLike, id: number): Promise<void>;
  /** 邮箱验证码二次登录开关（SMTP 前置校验在 app 编排——port 不判 SMTP） */
  setTwoFactorEnabled(db: DbLike, input: { adminId: number; enabled: boolean }): Promise<void>;
  /** 管理面列表（统一列表契约:分页 + q 搜索 + 排序白名单在 app 层裁决） */
  list(db: DbLike, query: AdminListQuery): Promise<AdminListResult>;
  /** 创建资料行（id ≥1e9 段分配与插入同事务——application 负责开事务;
   *  重名由 admins_email_uq 兜底,23505 由 application 翻译冲突） */
  create(db: DbTx, row: CreateAdminRow): Promise<AdminRecord>;
  /** 部分更新（未命中返回 null——admin_not_found 由 application 抛） */
  update(db: DbLike, row: UpdateAdminRow): Promise<AdminRecord | null>;
  /** 补偿删除（创建流程凭据注册失败时收回资料行——只此一个消费方） */
  remove(db: DbLike, adminId: number): Promise<void>;
}
