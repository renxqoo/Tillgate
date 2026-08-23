/**
 * RateCardStore port：费率卡（定价档位）与系数行的持久化边界。
 * 用户价 = 官方价 × 系数；系数解析优先级 model > group > global 的消费方在 billing/inference。
 * 不变量（application 在事务内调用保证）：每卡恰一行 scope='global' 兜底系数。
 */
import type { DbLike } from '@tokenlens/db';
import type { ListQuery, ListResult } from '../domain/list';

export interface RateCardRecord {
  readonly id: number;
  readonly name: string;
  readonly description: string | null;
  readonly status: number;
  readonly createdAt: Date;
}

export interface RateCardUserRow {
  readonly id: number;
  readonly subject: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly createdAt: Date;
}

export type RateCardSortField = 'id' | 'name' | 'status' | 'createdAt';
export type RateCardUserSortField = 'id' | 'subject' | 'createdAt';


/**
 * 用户费率卡上下文（G1，gateway P5 波）：绑卡 + 系数行全集（model/group/global）。
 * 卡停用（status≠0）也如实返回——「停用卡拒绝新请求」的裁决在消费方（v1 403
 * rate_card_disabled 语义）。
 */
export interface UserRateCardContext {
  readonly cardId: number;
  readonly cardName: string;
  readonly status: number;
  readonly coefficients: ReadonlyArray<{
    scope: 'model' | 'group' | 'global';
    modelMappingId: number | null;
    groupKey: string | null;
    coefficient: string;
  }>;
}

export interface RateCardStore {
  /** 建卡 + 全局兜底系数（同事务两写）；返回新卡 */
  insertWithGlobal(
    db: DbLike,
    input: { name: string; description: string | null; coefficient: string },
  ): Promise<RateCardRecord>;
  findById(db: DbLike, rateCardId: number): Promise<RateCardRecord | null>;
  /**
   * 更新卡面 + 全局系数（同事务）：globalCoefficient 非 undefined 时只更新
   * scope='global' 行——model/group 覆写行隔离（M1 静默价格漂移回归点）。
   * 0 行 = 卡不存在。
   */
  updateWithGlobal(
    db: DbLike,
    input: {
      rateCardId: number;
      patch: { name?: string; description?: string | null; status?: number };
      globalCoefficient?: string;
    },
  ): Promise<{ id: number; name: string } | null>;
  /** 绑定用户数（跨域只读 users.rateCardId——accounts 波次后改经 facade） */
  countBoundUsers(db: DbLike, rateCardId: number): Promise<number>;
  /** 硬删（系数行先于卡行——FK NO ACTION；存在性由返回值表达） */
  deleteCard(db: DbLike, input: { rateCardId: number }): Promise<boolean>;
  /** 卡列表 + 各卡全局系数（缺行 = null，application 按 '1.000' 兜底回显） */
  list(
    db: DbLike,
    query: ListQuery<RateCardSortField>,
  ): Promise<ListResult<RateCardRecord & { globalCoefficient: string | null }>>;
  /** 绑定该卡的用户（q 命中 subject/email/displayName） */
  listCardUsers(
    db: DbLike,
    query: ListQuery<RateCardUserSortField> & { rateCardId: number },
  ): Promise<ListResult<RateCardUserRow>>;
  /** 健康自检：全局兜底系数是否存在（「每卡恰一全局行」约束） */
  findGlobalCoefficient(db: DbLike, rateCardId: number): Promise<string | null>;
  // ---- 网关热路径读（G1，gateway P5 波；users.rate_card_id 读侧 join——绑定事实归 accounts 写侧） ----
  /** 用户绑定的费率卡 + 系数行全集；未绑卡返回 null */
  findActiveCardByUser(db: DbLike, userId: number): Promise<UserRateCardContext | null>;
}
