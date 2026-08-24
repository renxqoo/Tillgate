import { TextFeaturesAccumulator } from '../usage/features';
import type { StreamError } from '../types';
import { createSseEventReader, SseBoundaryTracker, type SseEvent } from './sse';

/**
 * SSE 旁路扫描器（S1 重构）：基于统一解析原语（transport/sse）+
 * 四计数器特征累积（O(1) 内存，替代 v1 outputText 文本累积与 4MB CAP）。
 * relay-stream 把上游 chunk 原样透传的同时 feed 给本扫描器——扫描结果用于
 * 计量（usage/估算特征）与心跳边界判定，绝不缓冲正文。
 */

export interface SseScannerCallbacks {
  /** 捕获到首个错误帧时通知（relay 在透传的同时发 stream_error 事件） */
  onErrorFrame?: (frame: StreamError) => void;
}

/** 事件 JSON 解析：非对象形（含解析失败）→ null（旁路扫描不中断透传） */
function parseEventJson(data: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(data);
    if (typeof v !== 'object' || v === null) return null;
    return v as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** tool_calls 片段的函数名/参数计入特征（名称与参数串都是输出 token 载体） */
function accumulateToolCallFeatures(toolCalls: unknown, features: TextFeaturesAccumulator): void {
  if (!Array.isArray(toolCalls)) return;
  for (const tc of toolCalls) {
    if (typeof tc !== 'object' || tc === null) continue;
    const fn = (tc as Record<string, unknown>).function;
    if (typeof fn !== 'object' || fn === null) continue;
    const f = fn as Record<string, unknown>;
    if (typeof f.name === 'string') features.addText(f.name);
    if (typeof f.arguments === 'string') features.addText(f.arguments);
  }
}

/** delta 片段计入特征（content / reasoning_content / tool_calls 参数） */
function accumulateDeltaFeatures(
  delta: Record<string, unknown>,
  features: TextFeaturesAccumulator,
): void {
  if (typeof delta.content === 'string') features.addText(delta.content);
  if (typeof delta.reasoning_content === 'string') features.addText(delta.reasoning_content);
  accumulateToolCallFeatures(delta.tool_calls, features);
}

export class SseScanner {
  private usage: unknown | null = null;
  private errorFrame: StreamError | null = null;
  private doneReceived = false;
  private terminalFrameReceived = false;
  private eventsCompleted = 0;
  private lastEventAt = 0;
  private boundary = new SseBoundaryTracker();
  /** 行超限等解析故障后停止旁路扫描（不影响透传；防止 reader 缓冲反复重放增长） */
  private broken = false;
  /** 输出内容特征（估算源；usage 缺失/取消时的 output token 依据） */
  private features = new TextFeaturesAccumulator();

  private reader = createSseEventReader((ev: SseEvent) => {
    if (ev.data === '[DONE]') {
      this.doneReceived = true;
      this.eventsCompleted += 1;
      this.lastEventAt = Date.now();
      return;
    }
    const parsed = parseEventJson(ev.data);
    if (parsed === null) return; // 非 JSON 帧不中断透传（扫描是旁路）
    this.eventsCompleted += 1;
    this.lastEventAt = Date.now();
    this.noteTerminalFrame(parsed);
    if (parsed.usage !== undefined && parsed.usage !== null) {
      // 最后 usage 帧胜出；usage:null 忽略（部分供应商中间/尾帧带 null，避免覆盖真实值）
      this.usage = parsed.usage;
    }
    this.accumulateOutput(parsed);
    if (this.errorFrame === null && parsed.error !== undefined) {
      this.errorFrame = toErrorFrame(parsed.error);
      this.callbacks?.onErrorFrame?.(this.errorFrame);
    }
  });

  /** 终止帧判定：任一 choice 带 finish_reason 字符串（终止帧到达） */
  private noteTerminalFrame(parsed: Record<string, unknown>): void {
    if (!Array.isArray(parsed.choices)) return;
    for (const choice of parsed.choices) {
      if (
        typeof choice === 'object' &&
        choice !== null &&
        typeof (choice as Record<string, unknown>).finish_reason === 'string'
      ) {
        this.terminalFrameReceived = true;
        break;
      }
    }
  }

  constructor(private readonly callbacks?: SseScannerCallbacks) {}

  /** 喂入上游 chunk；返回本次完成的完整事件数（心跳边界判定用） */
  consume(chunk: Uint8Array): number {
    const before = this.eventsCompleted;
    if (this.broken) return 0;
    // 行文本喂边界跟踪（decode 与 reader 内部各自独立流式解码，字符一致）
    const text = new TextDecoder('utf-8').decode(chunk, { stream: true });
    this.boundary.track(text);
    try {
      this.reader.push(chunk);
    } catch {
      // 解析容错：行超限等异常 chunk 不中断透传（扫描是旁路）——但停止后续扫描
      this.broken = true;
    }
    return this.eventsCompleted - before;
  }

  atBoundary(): boolean {
    return this.boundary.atBoundary();
  }
  getUsage(): unknown | null {
    return this.usage;
  }
  getErrorFrame(): StreamError | null {
    return this.errorFrame;
  }
  hasDone(): boolean {
    return this.doneReceived;
  }
  hasTerminalFrame(): boolean {
    return this.terminalFrameReceived;
  }
  getLastEventAt(): number {
    return this.lastEventAt;
  }
  getFeatures(): TextFeaturesAccumulator {
    return this.features;
  }

  /**
   * 规范形帧 → 输出特征累计（delta.content / reasoning_content / text /
   * tool_calls 参数；按片段统计后累加——与估算层口径一致）。
   */
  private accumulateOutput(frame: Record<string, unknown>): void {
    const { choices } = frame;
    if (!Array.isArray(choices)) return;
    for (const choice of choices) {
      if (typeof choice !== 'object' || choice === null) continue;
      const c = choice as Record<string, unknown>;
      if (typeof c.delta === 'object' && c.delta !== null) {
        accumulateDeltaFeatures(c.delta as Record<string, unknown>, this.features);
      }
      if (typeof c.text === 'string') this.features.addText(c.text);
    }
  }
}

function toErrorFrame(error: unknown): StreamError {
  const e = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  let code = 'stream_error';
  if (typeof e.code === 'string') ({ code } = e);
  else if (typeof e.type === 'string') ({ type: code } = e);
  return {
    code,
    type: typeof e.type === 'string' ? e.type : undefined,
    detail: typeof e.message === 'string' ? e.message : undefined,
  };
}
