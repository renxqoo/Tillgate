'use client';

// 推荐运营导出面：两张表 + 视图切换（分域文件，index 只做导出面）

export { RelationsTable, type ReferralRelationRow } from './relations-table';
export { PayoutsTable, type PayoutRow } from './payouts-table';
export { ReferralsViewSelect } from './referrals-view-select';
