import { createParser } from 'eventsource-parser';
import type { StreamError } from '../types';

/**
 * SSE 增量扫描器（eventsource-parser v3 薄封装）：
 * 事件边界 / 注释行 / 多行 data / usage 最后帧胜出 / 错误帧捕获
 *
 * 旁路架构：relay-stream 把上游 chunk 原样写入输出流（透传），
 * 同时 feed 给本扫描器（不消费流）——扫描结果用于计量与心跳边界判定。
 */

export interface SseScannerCallbacks {
  /** 每个完整事件触发（data 为多行 data 拼接后的原文，event 为事件名） */
  onEvent?: (data: string, event: string | undefined) => void;
  /** 捕获到首个错误帧时通知（relay 用它在透传的同时发 stream_error 事件） */
  onErrorFrame?: (frame: StreamError) => void;
}

/** 累计输出文本的内存上界（超出即停止累计——估算口径足够，防超长流撑爆内存） */
const OUTPUT_TEXT_CAP = 4 * 1024 * 1024;

export class SseScanner {
  private usage: unknown | null = null;
  private errorFrame: StreamError | null = null;
  private doneReceived = false;
  private terminalFrameReceived = false;
  private eventsCompleted = 0;
  private lastEventAt = 0;
  /**
   * 输出内容累计（规范形 delta.content / reasoning_content / text / tool_calls 参数）：
   * usage 缺失或用户中途取消时的输出 token 估算源——否则输出按 0 计费 = 漏收。
   */
  private outputText = '';

  /** stream 模式：跨 chunk 的多字节 UTF-8 安全解码（feed 需 string） */
  private decoder = new TextDecoder('utf-8');

  /** 事件边界状态机（心跳注入判定）：最近结束的行是否为空行 */
  private lastLineEnded = false;
  private lastLineWasBlank = false;
  private lineHasContent = false;

  private parser = createParser({
    onEvent: (ev) => {
      // v3.1: EventSourceMessage = { data, event?, id? }，无 type 判别字段
      if (typeof ev.data !== 'string') return;
      this.eventsCompleted += 1;
      this.lastEventAt = Date.now();
      this.callbacks?.onEvent?.(ev.data, ev.event);
      if (ev.data === '[DONE]') {
        this.doneReceived = true;
        return;
      }
      const parsed = this.tryParse(ev.data);
      if (!parsed) return;
      if (
        Array.isArray(parsed.choices) &&
        parsed.choices.some((choice) => {
          if (typeof choice !== 'object' || choice === null) return false;
          return typeof (choice as Record<string, unknown>).finish_reason === 'string';
        })
      ) {
        this.terminalFrameReceived = true;
      }
      if (parsed.usage !== undefined && parsed.usage !== null) {
        // 最后 usage 帧胜出；忽略 usage:null（部分供应商中间/尾帧带 null，避免覆盖真实 usage）
        this.usage = parsed.usage;
      }
      this.accumulateOutput(parsed);
      if (this.errorFrame === null && parsed.error !== undefined) {
        this.errorFrame = this.toErrorFrame(parsed.error);
        this.callbacks?.onErrorFrame?.(this.errorFrame);
      }
    },
  });

  constructor(private readonly callbacks?: SseScannerCallbacks) {}

  /** 喂入上游 chunk；返回本次完成的完整事件数（心跳边界判定用） */
  consume(chunk: Uint8Array): number {
    const before = this.eventsCompleted;
    const text = this.decoder.decode(chunk, { stream: true });
    try {
      this.parser.feed(text);
    } catch {
      // 解析容错：异常 chunk 不中断透传（扫描是旁路）
    }
    this.trackBoundary(text);
    return this.eventsCompleted - before;
  }

  /**
   * 当前是否位于 SSE 事件边界（可安全注入 ': keep-alive' 心跳帧）。
   * 边界 = 最近一个以 \n 结束的行是空行，且当前没有未完成行内容——
   * "data: a\n"（行结束但事件未完）不算边界，防止心跳拆开半截事件。
   */
  atBoundary(): boolean {
    return !this.lineHasContent && (!this.lastLineEnded || this.lastLineWasBlank);
  }

  /** 行级边界跟踪：只关心"空行是否已发生"，不缓存行内容（O(1) 内存） */
  private trackBoundary(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\n') {
        this.lastLineEnded = true;
        this.lastLineWasBlank = !this.lineHasContent;
        this.lineHasContent = false;
      } else if (ch !== '\r') {
        // \r 不改变状态：CRLF 的 \r 被忽略，\n 统一判定（SSE 规范只认 \n）
        this.lineHasContent = true;
      }
    }
  }

  /** 最后 usage 帧（解析后的原始 usage 对象，null = 流中无 usage） */
  getUsage(): unknown | null {
    return this.usage;
  }

  /** 首个错误帧（流式错误），null = 无 */
  getErrorFrame(): StreamError | null {
    return this.errorFrame;
  }

  /** 上游是否发送了 OpenAI-compatible `[DONE]` 终止事件。 */
  hasDone(): boolean {
    return this.doneReceived;
  }

  /** 上游是否在 choices 中发送了非空 finish_reason。 */
  hasTerminalFrame(): boolean {
    return this.terminalFrameReceived;
  }

  /** 最近一次完整事件的时间戳（心跳判定） */
  getLastEventAt(): number {
    return this.lastEventAt;
  }

  /**
   * 累计的输出内容文本（规范形帧的 delta 累积；上界 OUTPUT_TEXT_CAP）。
   * 供 usage 缺失/用户取消时估算输出 token——计量兜底，非精确值。
   */
  getOutputText(): string {
    return this.outputText;
  }

  reset(): void {
    this.usage = null;
    this.errorFrame = null;
    this.doneReceived = false;
    this.terminalFrameReceived = false;
    this.eventsCompleted = 0;
    this.lastEventAt = 0;
    this.outputText = '';
    this.lastLineEnded = false;
    this.lastLineWasBlank = false;
    this.lineHasContent = false;
    this.parser.reset();
  }

  /**
   * 规范形帧 → 输出内容文本累计（只读不消费流）：
   *   choices[].delta.content / delta.reasoning_content（流式 chat）
   *   choices[].text（补全类）
   *   delta.tool_calls[].function.name+arguments（工具调用输出）
   * usage 帧到达时清零重计（估算只在 usage 缺失路径消费——保持口径纯净）。
   */
  private accumulateOutput(frame: Record<string, unknown>): void {
    if (this.outputText.length >= OUTPUT_TEXT_CAP) return;
    const choices = frame.choices;
    if (!Array.isArray(choices)) return;
    const piece: string[] = [];
    for (const choice of choices) {
      if (typeof choice !== 'object' || choice === null) continue;
      const delta = (choice as Record<string, unknown>).delta;
      if (typeof delta !== 'object' || delta === null) continue;
      const d = delta as Record<string, unknown>;
      if (typeof d.content === 'string') piece.push(d.content);
      if (typeof d.reasoning_content === 'string') piece.push(d.reasoning_content);
      const text = (choice as Record<string, unknown>).text;
      if (typeof text === 'string') piece.push(text);
      const toolCalls = d.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (typeof tc !== 'object' || tc === null) continue;
          const fn = (tc as Record<string, unknown>).function;
          if (typeof fn !== 'object' || fn === null) continue;
          const f = fn as Record<string, unknown>;
          if (typeof f.name === 'string') piece.push(f.name);
          if (typeof f.arguments === 'string') piece.push(f.arguments);
        }
      }
    }
    if (piece.length === 0) return;
    this.outputText += piece.join('');
    if (this.outputText.length > OUTPUT_TEXT_CAP) {
      this.outputText = this.outputText.slice(0, OUTPUT_TEXT_CAP);
    }
  }

  private tryParse(data: string): Record<string, unknown> | null {
    try {
      const v = JSON.parse(data);
      return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private toErrorFrame(error: unknown): StreamError {
    const e = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
    return {
      code:
        typeof e.code === 'string' ? e.code : typeof e.type === 'string' ? e.type : 'stream_error',
      type: typeof e.type === 'string' ? e.type : undefined,
      detail: typeof e.message === 'string' ? e.message : undefined,
    };
  }
}
