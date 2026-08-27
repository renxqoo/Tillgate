/**
 * PG 错误分类:沿 cause 链探测 SQLSTATE,输出事实判定(唯一冲突/瞬态事务错误)。
 *
 * 本模块只做分类,不做翻译——SQLSTATE → HTTP 语义(4xx/5xx、错误码文案)属未来 http 包
 * 的 PG_CODE_MAP,db 不认识 HttpError(依赖方向)。
 *
 * 探测深度统一为全 cause 链——superset 方向,更深的冲突不再漏检;资金路径
 * 深度 >3 的唯一冲突漏检是兜底信号的真实缺陷,由回归用例锁定。
 *
 * 词形收紧:SQLSTATE = 5 位 [0-9A-Z] 且**至少含一位数字**(真实
 * SQLSTATE 子类恒含数字);系统 errno 串(EPERM/ELOOP/EPIPE/EACCES——pg 的 `code`
 * 连接层错误与 Bun SQL 的 `errno`)恒为纯字母,曾被 5 位词形误判为 SQLSTATE。
 */

/** 5 位大写字母数字词形(SQLSTATE 的形状面) */
const SQLSTATE_SHAPE = /^[0-9A-Z]{5}$/;

/** 词形 + 至少一位数字 = SQLSTATE 事实(errno 假阳性家族被排除) */
function isSqlState(value: string): boolean {
  return SQLSTATE_SHAPE.test(value) && /\d/.test(value);
}

/** 沿 cause 链产出各层错误载体(drizzle 会把驱动错误包在 cause 里) */
function* causeChain(err: unknown): Generator<Record<string, unknown>> {
  let cur: unknown = err;
  while (cur != null && typeof cur === 'object') {
    yield cur as Record<string, unknown>;
    cur = (cur as { cause?: unknown }).cause;
  }
}

/**
 * 单层载体上的 SQLSTATE:pg 在 `code`(如 '23505'),Bun SQL 在 `errno`
 * (其 `code` 是 ERR_POSTGRES_* 前缀的运行时码)——双字段探测。
 */
function sqlStateOf(holder: Record<string, unknown>): string | null {
  const { code, errno } = holder;
  if (typeof code === 'string' && isSqlState(code)) return code;
  if (typeof errno === 'string' && isSqlState(errno)) return errno;
  return null;
}

/** 任意 5 位 PG SQLSTATE(如 '23505');无则 null。参数可选:缺省/undefined 沿链探测即无结果 */
export function pgSqlState(err?: unknown): string | null {
  for (const holder of causeChain(err)) {
    const state = sqlStateOf(holder);
    if (state != null) return state;
  }
  return null;
}

/** PG 唯一约束冲突(23505)——并发重放双保险的兜底信号 */
export function isUniqueViolation(err: unknown): boolean {
  return pgSqlState(err) === '23505';
}

/**
 * 唯一约束冲突的约束名(区分哪个索引被撞);非唯一冲突、或 PG 未随错给出约束名时为 null。
 */
export function uniqueViolationConstraint(err: unknown): string | null {
  for (const holder of causeChain(err)) {
    if (sqlStateOf(holder) !== '23505') continue;
    const { constraint } = holder;
    return typeof constraint === 'string' ? constraint : null;
  }
  return null;
}

/** 瞬态事务错误(PG 死锁 40P01 / 串行化失败 40001)——幂等动词可安全重试的唯一信号 */
export function transientTxFailureCode(err: unknown): '40P01' | '40001' | null {
  const state = pgSqlState(err);
  return state === '40P01' || state === '40001' ? state : null;
}
