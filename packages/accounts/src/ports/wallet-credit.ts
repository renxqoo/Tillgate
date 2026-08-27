/**
 * WalletCreditPort:入账端口(开户赠送/邀请奖励)。
 * 生产实现由装配桥接 billing(app assembly 提供桥接件);
 * 包内测试用 testing/in-memory 替身。`db` 首参参与调用方事务——
 * applyReferral 的「关系+双方奖励同生共死」依赖此语义。
 *
 * 幂等由实现方经 (refType, refId) 自然键保证:重复入账返回 replayed=true 而非报错;
 * refType/refId 词表由 accounts domain 构造器单一真相。
 */
import type { DbLike } from '@tillgate/db';

/** 资金流类型:gift=注册赠送 / referral=推荐族(注册奖励、日结佣金) */
export type CreditRefType = 'gift' | 'referral';

export interface CreditCommand {
  readonly refType: CreditRefType;
  readonly refId: string;
  readonly userId: number;
  readonly amount: string;
  readonly memo?: string;
}

export interface CreditResult {
  /** true = 自然键命中,历史入账已存在,本次未新增 */
  readonly replayed: boolean;
}

export interface WalletCreditPort {
  credit(db: DbLike, command: CreditCommand): Promise<CreditResult>;
}
