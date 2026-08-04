/**
 * 鉴权中间件（双凭证：静态 Key 哈希查库 / JWT 本地验签）（骨架）
 * TODO(gateway):
 *   - Bearer 前缀判定（ag_ → apiKeys 哈希查询；否则 JWT 验签）
 *   - JWT: iss/exp/签名 + jti 黑名单（Redis）+ App 状态缓存
 *   - 输出统一调用上下文 {userId, appId?, coefficient, 限流维度}
 */
export const authMiddleware = () => async (c: any, next: () => Promise<void>) => {
  // TODO(gateway): 鉴权实现
  await next();
};
