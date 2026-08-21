/**
 * 内部科目表（领域词汇）：复式记账的固定对手方科目代码。
 * fail-closed 白名单（guards.internalAccounts）由装配声明；这些代码是白名单里的常客。
 */
/** 外部世界镜像科目（credit 入账默认对手方） */
export const OUTSIDE_ACCOUNT = 'outside';
/** 平台收入科目（settle 结算默认对手方——结算即收入确认） */
export const REVENUE_ACCOUNT = 'platform_revenue';
