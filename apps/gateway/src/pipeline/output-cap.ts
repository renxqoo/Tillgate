/**
 * 输出 token 上界（app 纯规则——预扣/敞口共用口径）：
 * max_completion_tokens > max_tokens > 装配缺省；× n 倍数；封顶 exposureCap。
 * cap 同时是实际转发硬上限，预扣敞口不会小于允许的实际输出。
 */
export interface OutputCapConfig {
  defaultMax: number;
  exposureCap: number;
}

/** 端点类型：embeddings 无输出；chat 按参数口径 */
export function maxOutputTokensFor(
  kind: 'chat' | 'embeddings' | 'modality',
  body: Record<string, unknown>,
  config: OutputCapConfig,
): number {
  if (kind === 'embeddings') return 0;
  return maxOutputTokens(body, config);
}

export function maxOutputTokens(
  body: Record<string, unknown>,
  config: OutputCapConfig,
): number {
  const requested =
    typeof body.max_completion_tokens === 'number' && body.max_completion_tokens > 0
      ? body.max_completion_tokens
      : typeof body.max_tokens === 'number' && body.max_tokens > 0
        ? body.max_tokens
        : config.defaultMax;
  const count = typeof body.n === 'number' && body.n > 0 ? body.n : 1;
  return Math.min(requested * count, config.exposureCap);
}

/**
 * 转发体输出上限钳制：客户端声明的 max_tokens/max_completion_tokens 超出预扣口径
 * （outputCap 已含 n 倍数）时压到口径内——「预估敞口 ≥ 实际输出」的结构性保证。
 * 未声明输出上限时注入 max_completion_tokens，禁止无限输出越过预扣敞口。
 * 返回原对象引用（无改动时）避免无谓拷贝。
 */
export function clampForwardedOutputLimit(
  body: Record<string, unknown>,
  outputCap: number,
): Record<string, unknown> {
  const count = typeof body.n === 'number' && body.n > 0 ? body.n : 1;
  const perCompletion = Math.floor(outputCap / count);
  if (perCompletion <= 0) return body;
  const out = { ...body };
  let touched = false;
  const mct = out.max_completion_tokens;
  if (typeof mct === 'number' && Number.isFinite(mct) && mct > perCompletion) {
    out.max_completion_tokens = perCompletion;
    touched = true;
  }
  const mt = out.max_tokens;
  if (typeof mt === 'number' && Number.isFinite(mt) && mt > perCompletion) {
    out.max_tokens = perCompletion;
    touched = true;
  }
  if (mct === undefined && mt === undefined) {
    out.max_completion_tokens = perCompletion;
    touched = true;
  }
  return touched ? out : body;
}

/**
 * JSON UTF-8 字节数是文本 token 数的保守上界；与分词估算取最大值，覆盖未知模型、
 * chat template 和工具定义低估。多模态会更保守，但只增加临时预留，不增加实扣。
 */
export function conservativeInputTokenUpperBound(
  body: Record<string, unknown>,
  estimated: number,
): number {
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  } catch {
    return estimated;
  }
  return Math.max(estimated, bytes);
}
