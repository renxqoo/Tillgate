/** 熔断状态持久化接口（gateway 注入 Redis 实现，多实例共享熔断状态） */
export type { BreakerState, BreakerStorage } from '../config.js'
