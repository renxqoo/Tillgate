/**
 * JWT scope.models 越权校验（S3）。
 *
 * JWT 签发时可带 scope.models 白名单（企业 Agent 限定可用模型）。
 * chat/embeddings 路由在鉴权后、计费前调用本函数校验：
 *   - allowedModels = null → 静态 Key，不限模型
 *   - allowedModels = [] → 空数组视为不限（配置容错：JWT payload 里 models 为空数组时不拦）
 *   - allowedModels 非空 → 精确匹配（防前缀注入：gpt-4o-mini ≠ gpt-4o）
 */
export function isModelAllowed(allowedModels: string[] | null, model: string): boolean {
  if (allowedModels === null) return true; // 静态 Key 不限
  if (allowedModels.length === 0) return true; // 空数组容错（视为不限）
  return allowedModels.includes(model); // 精确匹配（includes 是 === 比较，大小写敏感）
}
