/**
 * redis 家族共享的纯诊断格式化件（单一真相）：
 * create-redis-client（降级日志）与 assert-redis-reachable（启动报错）共用。
 */

/** 日志脱敏：URL 带认证信息时抹掉（redis://:pass@host → redis://***@host） */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return url;
  }
}

/** 可读错误描述：AggregateError（多地址都失败）的 message 是空串——展开内层原因 */
export function describeError(err: Error): string {
  const inner = (err as { errors?: Error[] }).errors;
  if (!err.message && inner?.length) {
    return `${err.name}（${inner.map((e) => e.message).join('; ')}）`;
  }
  return err.message || err.name;
}
