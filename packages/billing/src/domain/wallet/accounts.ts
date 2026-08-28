/**
 * 钱包账户词汇与形状（domain 内部约定，无 I/O）：
 * 复式记账的固定对手方科目代码 + 账户引用/快照形状。
 * fail-closed 白名单（guards.internalAccounts）由装配声明；这些代码是白名单里的常客。
 */
/** 外部世界镜像科目（credit 入账默认对手方） */
export const OUTSIDE_ACCOUNT = 'outside';

/** 平台收入科目（settle 结算默认对手方——结算即收入确认） */
export const REVENUE_ACCOUNT = 'platform_revenue';

/** 账户引用：用户（userId）或内部科目（code）二选一 */
export type AccountRef = { userId: number } | { code: string };

/** 账户快照（adapters 装载的仓储行形状；kind/status 为库中字符串，语义判定见守卫函数） */
export interface AccountSnapshot {
  id: string;
  kind: string;
  code: string | null;
  currency: string;
  balance: string;
  inFlight: string;
  creditLimit: string;
  /** 结算透支地板（缺省 '0' = 不透支；旧快照实现未携带时按 0 口径） */
  debitFloor?: string;
  /** 地板来源（default/manual；管理面读取用，旧实现未携带时按 default） */
  debitFloorSource?: string;
  status: string;
}
