/**
 * 错误分类矩阵 + 死凭据文本特征（骨架）
 * 一次分类同时驱动：retryable（重试）/ circuitTrip（熔断计数）/ deadCredential（凭据无效）
 */
// TODO(ai): 实现矩阵：
//   5xx/网络/超时 → retryable ✅ circuitTrip ✅
//   429           → retryable ✅ circuitTrip ❌
//   401/403（含 invalid api key 等文本特征）→ deadCredential ✅ circuitTrip ❌ retryable ❌
//   400/404       → retryable ❌ circuitTrip ❌
export type { UpstreamError } from '../types.js';
