/**
 * 收据校准预估（calibrated exposure estimate——docs/calibrated-exposure-estimate.md §2）。
 *
 * 安全性/经济性分离（I0，方案 D16）：本模块产出只服务经济性消费面
 * （authorize 冻结额、reserveChannel 敞口）；B2 验收钳制、缺陷熔断、
 * B4 死信阈值**永不消费**校准界——它们只认字节界与 conservative_channel_amount。
 * 校准预估偏低的代价被结构性限制为「一笔超额事件」（结算侧有界路径），
 * 不可能产生钳制事实、缺陷计数或死信。
 *
 * 哈希链（§2.1）：逐消息 sha256 + 链式前缀哈希，一遍线性递推；
 * 多模态 part 按完整规范化 JSON 参与哈希（同哈希 ⇔ 同内容 ⇒ 厂商对同内容
 * 计数确定——长度占位符会让不同图同长度误命中，禁用）。
 */
import { createHash } from 'node:crypto';

/**
 * 校准记录读侧形状（ports 注入的 store 返回；settle 写入侧见 billing）。
 * userId/mappingId 由调用方上下文携带（查询键即过滤键——行内冗余不参与匹配）。
 */
export interface CalibrationRecord {
  prefixHash: string;
  channelId: number;
  /** 上一笔收据实测 inputTokens（C7b 保证 ≥ prefixBytes/4） */
  inputTokens: number;
  messagesLen: number;
  settledAt: Date;
}

/** 写入侧输入（结算路径组装；C7 守卫在 writeCalibrationRecord 判定） */
export interface CalibrationWriteInput {
  userId: number;
  mappingId: number;
  channelId: number;
  inputTokens: number;
  messagesLen: number;
  /** 本请求前缀（system+tools+messages 全量）的规范化字节长度（C7b 下限基准） */
  prefixBytes: number;
  /** 收据是否携带钳制事实（acceptTrustedUsage 后 clamps 非空 → 拒写） */
  clamped: boolean;
}

/** 校准读侧解析结果（quote 消费；fallback = 保守回落，携带原因进观测） */
export type CalibrationResolution =
  | {
      hit: true;
      seen: number;
      prefixHash: string;
      channelId: number;
      messagesLen: number;
    }
  | { hit: false; missReason: CalibrationMissReason };

export type CalibrationMissReason =
  | 'guard' // C6：非 chat 族 / 空 messages（读写双侧结构性排除）
  | 'no_record' // 无匹配记录
  | 'prefix' // C2：前缀不匹配（改写/收缩）
  | 'window' // C4：超窗（含 margin）
  | 'disabled'; // 读侧开关关闭（enabled=false 时 quote 跳过查询）

export interface CalibrationReadConfig {
  enabled: boolean;
  windowMs: number;
  /** C4 窗口 margin（路由+有界等待上界，结构常量 30s——非运营参数） */
  windowMarginMs: number;
}

/** canonical JSON：字段名排序、无空白（哈希稳定性——同内容跨请求字节恒等） */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** §2.0' 适用域守卫（C6，读写双侧同款）：chat 族且 messages 为非空数组 */
export function calibrationGuard(input: { endpoint: string; body: Record<string, unknown> }): boolean {
  if (input.endpoint !== 'chat') return false;
  const { messages } = input.body;
  return Array.isArray(messages) && messages.length > 0;
}

/**
 * 消息哈希链（§2.1）：返回逐消息哈希与 h_sys。
 * chain(k) = sha256(h_sys ‖ h_0 ‖ … ‖ h_{k-1}) 由 chainAt 增量递推。
 */
export interface MessageHashChain {
  systemHash: string;
  messageHashes: string[];
  /** chain(0) = sha256(h_sys)；k 超长返回 chain(messages.length) */
  chainAt(k: number): string;
}

export function buildMessageHashChain(input: {
  body: Record<string, unknown>;
}): MessageHashChain | null {
  const { system, tools, messages } = input.body;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const systemHash = sha256Hex(canonicalJson({ system: system ?? null, tools: tools ?? null }));
  const messageHashes: string[] = [];
  // 链式前缀：chains[k] = chain(k)（k 条消息处的前缀哈希）；O(n) 内存，n=消息数
  const chains: string[] = [systemHash];
  let cur = systemHash;
  for (const message of messages) {
    const h = sha256Hex(canonicalJson(message));
    messageHashes.push(h);
    cur = sha256Hex(cur + h);
    chains.push(cur);
  }
  return {
    systemHash,
    messageHashes,
    chainAt: (k: number) => chains[Math.min(Math.max(k, 0), messageHashes.length)]!,
  };
}

/**
 * 读侧匹配（C1-C6）：对 top-N 记录逐条比对 chain(messagesLen)。
 * 返回 hit 或结构化 miss 原因（观测消费）。records 由 port 提供（top-N 现读）。
 */
export function resolveCalibration(input: {
  config: CalibrationReadConfig;
  records: readonly CalibrationRecord[];
  chain: MessageHashChain;
  now: Date;
}): CalibrationResolution {
  const { config, records, chain, now } = input;
  let sawRecord = false;
  for (const record of records) {
    if (record.messagesLen > chain.messageHashes.length) continue; // 收缩 → 前缀不可能匹配
    if (chain.chainAt(record.messagesLen) !== record.prefixHash) continue; // C2
    sawRecord = true;
    const ageMs = now.getTime() - record.settledAt.getTime();
    if (ageMs > config.windowMs - config.windowMarginMs) continue; // C4（含 margin）
    return {
      hit: true,
      seen: record.inputTokens,
      prefixHash: record.prefixHash,
      channelId: record.channelId,
      messagesLen: record.messagesLen,
    };
  }
  return { hit: false, missReason: sawRecord ? 'window' : 'no_record' };
}

/**
 * C7 写入守卫（§2.2）：结算写记录前的全部判定。
 * - C7a 零钳制：被 B2 钳过的收据计数器不可信，不得成链路锚点；
 * - C7b 物理下限：文本 bytes/token ≤ 4 恒成立（GPT 系最宽 ~4B/token），
 *   seen < prefixBytes/4 说明计数器低报（口径排除/清零 bug）——拒写；
 * - C7c 结构：有限正整数。
 */
export function calibrationWriteGuard(input: CalibrationWriteInput): boolean {
  const { inputTokens, messagesLen, prefixBytes, clamped } = input;
  if (clamped) return false; // C7a
  if (!Number.isSafeInteger(inputTokens) || inputTokens <= 0) return false; // C7c
  if (!Number.isSafeInteger(messagesLen) || messagesLen <= 0) return false;
  if (!Number.isSafeInteger(prefixBytes) || prefixBytes <= 0) return false;
  const floorTokens = Math.ceil(prefixBytes / 4); // C7b（媒体段只增不减）
  return inputTokens >= floorTokens;
}

/**
 * 渠道侧校准金额（§2.3 分段公式——仅渠道匹配时消费）：
 *   cacheSeg = floor(seen × ratio) × max(读价, 写价)
 *   rest（残留 10% + 尾部）× max(输入价, 写价)   ← 残留段同样含写价（P3）
 *   + 输出价 × 输出上限
 * 十进制字符串运算（billing 精度纪律——金额零浮点）。
 */
export function calibratedChannelAmount(input: {
  seen: number;
  tailTokens: number;
  cacheRatio: number;
  inputPrice: string;
  cacheInputPrice: string;
  cacheWritePrice: string | null;
  outputPrice: string;
  maxOutputTokens: number;
}): { amount: string } | null {
  const ratio = input.cacheRatio;
  if (!(ratio > 0) || ratio > 1) return null; // 值域锁（zod 同款；防御读侧）
  const cacheSegTokens = Math.floor(input.seen * ratio);
  const restTokens = input.seen + input.tailTokens - cacheSegTokens;
  if (restTokens < 0) return null; // 负段 = 输入不自洽
  // 字符串十进制乘法（token 数为整数 × 每百万价）——避免引入浮点中间态
  const cachePrice = maxDecimal(input.cacheInputPrice, input.cacheWritePrice);
  const restPrice = maxDecimal(input.inputPrice, input.cacheWritePrice);
  const cacheSeg = mulTokensPrice(cacheSegTokens, cachePrice);
  const rest = mulTokensPrice(restTokens, restPrice);
  const output = mulTokensPrice(input.maxOutputTokens, input.outputPrice);
  return { amount: addDecimals(addDecimals(cacheSeg, rest), output) };
}

// ---- 十进制字符串运算（无浮点；billing 金额纪律的 inference 侧镜像）----

function parseDecimalToUnits(s: string): bigint | null {
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const [whole = '0', frac = ''] = s.split('.') as [string, string];
  const units = BigInt(whole) * 10n ** 18n + (frac ? padFrac(frac) : 0n);
  return units < 0n ? null : units;
  function padFrac(f: string): bigint {
    const padded = (f + '0'.repeat(18)).slice(0, 18);
    return BigInt(padded);
  }
}

function unitsToDecimal(u: bigint): string {
  const whole = u / 10n ** 18n;
  const frac = (u % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return frac.length === 0 ? whole.toString() : `${whole}.${frac}`;
}

function mulTokensPrice(tokens: number, pricePerMillion: string): string {
  const units = parseDecimalToUnits(pricePerMillion);
  if (units == null || !Number.isSafeInteger(tokens) || tokens < 0) return '0';
  // tokens × price / 1e6，18 位小数地板：先乘后除保精度
  const scaled = units * BigInt(tokens);
  return unitsToDecimal(scaled / 10n ** 6n);
}

function addDecimals(a: string, b: string): string {
  const ua = parseDecimalToUnits(a);
  const ub = parseDecimalToUnits(b);
  if (ua == null || ub == null) return '0';
  return unitsToDecimal(ua + ub);
}

function maxDecimal(a: string, b: string | null): string {
  const ua = parseDecimalToUnits(a);
  if (b == null || ua == null) return a;
  const ub = parseDecimalToUnits(b);
  if (ub == null || ua >= ub) return a;
  return b;
}
