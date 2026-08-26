/**
 * PG 错误分类:沿 cause 链探测 SQLSTATE,输出事实判定(唯一冲突/瞬态事务错误)。
 *
 * 本模块只做分类,不做翻译——SQLSTATE → HTTP 语义(4xx/5xx、错误码文案)属未来 http 包
 * 的 PG_CODE_MAP,db 不认识 HttpError(依赖方向,DESIGN.md §3)。
 *
 * 统一裁决(B3):v1 四份实现探测深度不一(wallet 3 层 / identity-core 5 层 / core 正则无限),
 * 此处统一为全 cause 链——superset 方向,更深的冲突不再漏检;wallet 路径深度 >3 的唯一
 * 冲突漏检是资金路径兜底信号的真实缺陷,由回归用例锁定。
 */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/** 沿 cause 链产出各层错误载体(v1 core 全链语义;drizzle 会把驱动错误包在 cause 里) */
function* causeChain(err: unknown): Generator<Record<string, unknown>> {
  let cur: unknown = err;
  while (cur != null && typeof cur === 'object') {
    yield cur as Record<string, unknown>;
    cur = (cur as { cause?: unknown }).cause;
  }
}

/**
 * 单层载体上的 SQLSTATE:pg 在 `code`(如 '23505'),Bun SQL 在 `errno`
 * (其 `code` 是 ERR_POSTGRES_* 前缀的运行时码)——双字段探测,5 位词形即事实。
 */
function sqlStateOf(holder: Record<string, unknown>): string | null {
  const { code, errno } = holder;
  if (typeof code === 'string' && SQLSTATE.test(code)) return code;
  if (typeof errno === 'string' && SQLSTATE.test(errno)) return errno;
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
 * (v1 identity-core 以 '' 表示"冲突但无名",此处改用 null;其当时无外部消费者,无行为风险。)
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
