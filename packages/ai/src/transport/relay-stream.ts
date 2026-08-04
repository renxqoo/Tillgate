/**
 * 透传管道：心跳注入（静默 >30s，仅 SSE 事件边界）/
 * abort 传播 / 流式错误帧转换（骨架）
 */
// TODO(ai): 实现：
//   - 读循环：同一时刻只挂一个 read，与心跳定时器竞争
//   - 静默超时（inactivityTimeoutMs）→ 断流 + 错误帧
//   - 客户端 abort → 取消上游 reader（停止生成）
//   - 输出流注入 ': keep-alive'（仅事件边界，防拆半截事件）

/** 流式管道配置（待实现） */
export interface RelayStreamOptions {
  heartbeatIdleMs: number;
  inactivityTimeoutMs: number;
}
