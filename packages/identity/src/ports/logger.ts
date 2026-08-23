/** 告警观察面 port(与 clock/audit 同为注入的观察依赖;装配注入 runtime.createLogger 产物) */
export interface LoggerLike {
  warn(obj: unknown, msg: string): void;
}
