import type { Endpoint } from '../types';

/**
 * 生成类型描述符注册表（统一「视频/音频/图片/音乐」的基座词表，单一真相）：
 *
 * 每个生成类型一个纯函数描述符，回答四个问题——
 *   1. execution   执行模型：sync（网关内同步完成）/ task_poll（提交后 worker
 *                  轮询上游状态）/ task_execute（同步阻塞型上游，worker 代执行）
 *   2. unitsUpperBoundOf   预扣上界与结算快照的同一实现（此前 resolve.ts 与
 *                  attempt.ts 各写一份——重复即缺陷温床，现收敛于此）
 *   3. unitsOf     结算实值（sync 模态从响应体取实值；任务族结算用 DB 快照）
 *   4. snapshotParams      任务族提交参数白名单（快照进 generation_tasks.params，
 *                  music 代执行时原样作为上游请求体）
 *
 * 计费基座不变：金额恒 = units × unitPrice × 系数（packages/money 双分量公式），
 * 类型差异只体现在本表的 units 推导，新类型 = 注册一个描述符，零侵入执行层。
 * 新厂商 = packages/ai/adapters/task-kit.ts 配置一份（protocol 键注册）。
 */

/** 任务族 + 同步模态族的全部生成类型 */
export type GenerationKind = Exclude<Endpoint, 'chat' | 'embeddings'>;

export interface GenerationKindDescriptor {
  readonly kind: GenerationKind;
  /** 执行模型（gateway 提交分流与 worker 轮询分派的共同依据） */
  readonly execution: 'sync' | 'task_poll' | 'task_execute';
  /**
   * 单位上界（预扣口径；与结算快照同实现）：
   * video 且按秒计费 → duration（4-15 钳制，缺省 6——new-api #5498 教训）；
   * 其余 → n 倍数参数取正整数，缺省 1。
   */
  unitsUpperBoundOf(body: Record<string, unknown>, pricingUnit: string): number;
  /**
   * 结算实值：sync 模态从响应体取（images 实际张数 / STT 秒数）；
   * 任务族结算以 generation_tasks.units_snapshot 为准（提交时由
   * unitsUpperBoundOf 定格），此实现作为快照缺失时的兜底口径。
   */
  unitsOf(reqBody: Record<string, unknown>, resBody?: unknown): number;
  /** 任务族：提交参数快照白名单（music 的快照即 worker 代执行的请求体） */
  snapshotParams?(body: Record<string, unknown>): Record<string, unknown>;
}

/** duration 钳制（4-15s，缺省 6）——video 按秒计费的时长上界/快照 */
function clampedDuration(body: Record<string, unknown>): number {
  const d = body.duration;
  if (typeof d === 'number' && Number.isFinite(d)) return Math.min(15, Math.max(4, Math.round(d)));
  return 6;
}

/** n 倍数参数取正整数，缺省 1（张/次类上界） */
function positiveN(body: Record<string, unknown>): number {
  const n = body.n;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 1;
}

/** images 族结算实值：响应张数（data.length），兜底请求 n，最少 1 */
function imageUnits(reqBody: Record<string, unknown>, resBody?: unknown): number {
  const data = (resBody as { data?: unknown } | undefined)?.data;
  const fromResponse = Array.isArray(data) ? data.length : 0;
  return Math.max(1, fromResponse > 0 ? fromResponse : positiveN(reqBody));
}

const descriptor = (
  kind: GenerationKind,
  execution: GenerationKindDescriptor['execution'],
  unitsUpperBoundOf: GenerationKindDescriptor['unitsUpperBoundOf'],
  unitsOf: GenerationKindDescriptor['unitsOf'],
  snapshotParams?: GenerationKindDescriptor['snapshotParams'],
): GenerationKindDescriptor => ({ kind, execution, unitsUpperBoundOf, unitsOf, snapshotParams });

const nBound: GenerationKindDescriptor['unitsUpperBoundOf'] = (body) => positiveN(body);
const oneOf: GenerationKindDescriptor['unitsOf'] = () => 1;

/**
 * 注册表（kind 词表 = GenerationKind 全集，缺项启动即可见——消费方查不到即抛）。
 * 上界公式与重构前逐字等价（行为零变更）：非 video+second 一律 n 规则。
 */
export const GENERATION_KINDS: Readonly<Record<GenerationKind, GenerationKindDescriptor>> = {
  // ---- 任务族（异步生成：提交即返回，worker 驱动终态）----
  video: descriptor(
    'video',
    'task_poll',
    (body, pricingUnit) => (pricingUnit === 'second' ? clampedDuration(body) : positiveN(body)),
    (body, _resBody) => clampedDuration(body),
    (body) => ({
      model: body.model,
      prompt: body.prompt ?? '',
      ...(typeof body.duration === 'number' ? { duration: body.duration } : {}),
      ...(typeof body.size === 'string' ? { size: body.size } : {}),
      ...(typeof body.image === 'string' ? { image: body.image } : {}),
      ...(typeof body.last_frame_image === 'string' ? { last_frame_image: body.last_frame_image } : {}),
    }),
  ),
  music: descriptor(
    'music',
    'task_execute',
    nBound,
    oneOf,
    (body) => ({
      model: body.model,
      prompt: body.prompt ?? '',
      ...(typeof body.lyrics === 'string' ? { lyrics: body.lyrics } : {}),
    }),
  ),

  // ---- 同步模态族（网关内完成，响应体含计量实值）----
  images: descriptor('images', 'sync', nBound, imageUnits),
  images_edits: descriptor('images_edits', 'sync', nBound, imageUnits),
  audio_speech: descriptor('audio_speech', 'sync', nBound, (reqBody) => {
    const input = typeof reqBody.input === 'string' ? reqBody.input : '';
    return [...input].length;
  }),
  audio_transcription: descriptor('audio_transcription', 'sync', nBound, (reqBody) => {
    const s = reqBody.audioSeconds;
    return typeof s === 'number' && s > 0 ? Math.ceil(s) : 1;
  }),
  audio_translation: descriptor('audio_translation', 'sync', nBound, (reqBody) => {
    const s = reqBody.audioSeconds;
    return typeof s === 'number' && s > 0 ? Math.ceil(s) : 1;
  }),
  rerank: descriptor('rerank', 'sync', nBound, oneOf),
  moderations: descriptor('moderations', 'sync', nBound, oneOf),
};

export function generationKindDescriptor(kind: string): GenerationKindDescriptor | undefined {
  return (GENERATION_KINDS as Record<string, GenerationKindDescriptor | undefined>)[kind];
}

/** 任务族判定（execution ≠ sync）——gateway 提交分流 / worker 轮询分派共用 */
export function isTaskKind(kind: string): boolean {
  const d = generationKindDescriptor(kind);
  return d !== undefined && d.execution !== 'sync';
}
