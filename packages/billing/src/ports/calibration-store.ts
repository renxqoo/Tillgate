/**
 * 校准记录 port（docs/calibrated-exposure-estimate.md §3.1）：
 * 读侧 = inference 经 gateway 装配消费（quote 准备 top-N 现读）；
 * 写侧 = 结算事务末尾 upsert（C7 守卫后的可信事实）；
 * 清理 = worker 批后 best-effort（不占资金事务锁）。
 *
 * 记录是可重建的派生事实（结算重新积累）：读写任何一侧失败都安全回落
 * 保守口径——本 port 的实现不承载资金不变量（I0 安全分离）。
 */
import type { WalletConn } from './wallet-store.js';

/** 读侧行形状（inference resolveCalibration 的输入） */
export interface CalibrationRow {
  userId: number;
  mappingId: number;
  prefixHash: string;
  channelId: number;
  inputTokens: number;
  messagesLen: number;
  settledAt: Date;
}

/** 写侧输入（结算事务末尾；C7 守卫由调用方在写前判定） */
export interface CalibrationUpsertInput {
  userId: number;
  mappingId: number;
  prefixHash: string;
  channelId: number;
  inputTokens: number;
  messagesLen: number;
  requestId: string;
  now: Date;
}

export interface CalibrationStore {
  /** (user, mapping) settled_at 倒序 top-N（quote 准备现读；空数组安全回落） */
  findRecent(
    conn: WalletConn,
    input: { userId: number; mappingId: number; limit: number },
  ): Promise<readonly CalibrationRow[]>;
  /** 主键冲突覆盖（会话推进 hash 每笔都变，稳态即插入；无累积语义） */
  upsert(tx: WalletConn, input: CalibrationUpsertInput): Promise<void>;
  /**
   * 保留策略：每 (userId, mappingId) 保留最近 keep 条，驱逐更旧行。
   * worker 批后 best-effort 调用（结算事务外）；幂等，返回驱逐数（观测）。
   */
  cleanup(
    conn: WalletConn,
    input: { userId: number; mappingId: number; keep: number },
  ): Promise<number>;
}
