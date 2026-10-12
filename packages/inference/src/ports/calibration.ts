/**
 * 校准读侧 port（inference 视角——docs/calibrated-exposure-estimate.md §7）：
 * gateway 装配桥接 billing facade 的 findRecent；inference 零 billing import
 * （架构白名单），port 形状与 BillingPort 同模式。
 */
export interface CalibrationLookup {
  /** (user, mapping) top-N 现读（空数组安全回落保守——读失败安全方向） */
  findRecent(input: { userId: number; mappingId: number; limit: number }): Promise<
    ReadonlyArray<{
      prefixHash: string;
      channelId: number;
      inputTokens: number;
      messagesLen: number;
      settledAt: Date;
    }>
  >;
}

/**
 * 读侧配置快照（gateway KV TTL 缓存的解析结果；生效值随 quote 落快照）。
 * 校准恒开（用户裁决 2026-10-12）——无 enabled/user_side 开关；只剩调参。
 */
export interface CalibrationLookupConfig {
  windowMs: number;
  cacheRatio: number;
  /** 读请求的 top-N 上限（保留策略对齐，缺省 8） */
  recentLimit: number;
}
