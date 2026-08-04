/**
 * 熔断器原语：closed / open / half-open 状态机 + 滚动窗口计数（骨架）
 * 计数只收 circuitTrip=true 的错误（5xx/网络/超时）——429/4xx/死凭据不跳闸
 */
// TODO(ai): 实现状态机：
//   closed --60s 窗口失败 ≥threshold 或 5xx 率 >50%--> open（拒绝，快速失败）
//   open --冷却到期--> half-open（放 1 个请求探测）
//   half-open --成功--> closed；--失败--> 立即回 open
export interface BreakerDecision {
  allow: boolean
  reason?: 'circuit_open'
}
