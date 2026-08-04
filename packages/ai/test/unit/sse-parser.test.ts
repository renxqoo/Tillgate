import { describe, expect, it } from 'vitest';
import { SseScanner } from '../../src/transport/sse-parser.js';

const enc = (s: string) => new TextEncoder().encode(s);

describe('SseScanner', () => {
  it('多行 data 拼接为一个事件', () => {
    const events: string[] = [];
    const s = new SseScanner({ onEvent: (data) => events.push(data) });
    s.consume(enc('data: {"a":1}\ndata: {"b":2}\n\n'));
    expect(events).toEqual(['{"a":1}\n{"b":2}']);
  });

  it('注释行（心跳帧）不产生事件', () => {
    const events: string[] = [];
    const s = new SseScanner({ onEvent: (data) => events.push(data) });
    s.consume(enc(': keep-alive\n\n'));
    expect(events).toEqual([]);
    expect(s.getUsage()).toBeNull();
  });

  it('usage 最后帧胜出', () => {
    const s = new SseScanner();
    s.consume(enc('data: {"usage":{"prompt_tokens":1}}\n\n'));
    s.consume(
      enc('data: {"usage":{"prompt_tokens":2,"prompt_tokens_details":{"cached_tokens":9}}}\n\n'),
    );
    const usage = s.getUsage() as { prompt_tokens: number };
    expect(usage.prompt_tokens).toBe(2);
  });

  it('usage:null 中间帧不覆盖真实 usage（MiniMax 风格：全程 usage:null）', () => {
    // 真实场景：MiniMax-M3 流式每帧都带 "usage":null，从不发真实 usage。
    // 即使某些供应商中间帧发 null、尾帧发真实值，null 也不应覆盖已有真实 usage。
    const s = new SseScanner();
    s.consume(enc('data: {"choices":[{"delta":{"content":"a"}}],"usage":null}\n\n'));
    s.consume(enc('data: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n'));
    s.consume(enc('data: {"choices":[{"finish_reason":"stop"}],"usage":null}\n\n'));
    const usage = s.getUsage() as { prompt_tokens: number };
    expect(usage).not.toBeNull();
    expect(usage.prompt_tokens).toBe(5); // 不被尾帧的 null 覆盖
  });

  it('全程 usage:null → getUsage() 返回 null（供应商不发 usage）', () => {
    const s = new SseScanner();
    s.consume(enc('data: {"choices":[{"delta":{"content":"a"}}],"usage":null}\n\n'));
    s.consume(enc('data: {"choices":[{"delta":{"content":"b"}}],"usage":null}\n\n'));
    s.consume(enc('data: {"choices":[{"finish_reason":"stop"}],"usage":null}\n\n'));
    expect(s.getUsage()).toBeNull();
  });

  it('错误帧只捕获首个', () => {
    const s = new SseScanner();
    s.consume(enc('data: {"error":{"code":"rate_limited","message":"slow down"}}\n\n'));
    s.consume(enc('data: {"error":{"code":"other"}}\n\n'));
    const frame = s.getErrorFrame();
    expect(frame?.code).toBe('rate_limited');
    expect(frame?.detail).toBe('slow down');
  });

  it('chunk 跨 feed 拆分仍正确解析（事件边界完整）', () => {
    const events: string[] = [];
    const s = new SseScanner({ onEvent: (data) => events.push(data) });
    const full = 'data: {"usage":{"prompt_tokens":5}}\n\ndata: {"x":1}\n\n';
    const half = Math.floor(full.length / 2);
    const completed1 = s.consume(enc(full.slice(0, half)));
    const completed2 = s.consume(enc(full.slice(half)));
    expect(completed1 + completed2).toBe(2);
    expect(events.length).toBe(2);
    expect((s.getUsage() as { prompt_tokens: number }).prompt_tokens).toBe(5);
  });

  it('畸形 JSON 不崩溃、不影响后续事件', () => {
    const s = new SseScanner();
    s.consume(enc('data: not-json\n\n'));
    expect(s.getUsage()).toBeNull();
    expect(s.getErrorFrame()).toBeNull();
    s.consume(enc('data: {"usage":{"prompt_tokens":3}}\n\n'));
    expect((s.getUsage() as { prompt_tokens: number }).prompt_tokens).toBe(3);
  });

  it('event 名称透传给回调', () => {
    const names: (string | undefined)[] = [];
    const s = new SseScanner({ onEvent: (_data, event) => names.push(event) });
    s.consume(enc('event: error\ndata: {"error":{"code":"x"}}\n\n'));
    s.consume(enc('data: {"done":true}\n\n'));
    expect(names).toEqual(['error', undefined]);
  });

  it('eventsCompleted 计数与 consume 返回值', () => {
    const s = new SseScanner();
    expect(s.consume(enc('data: a\n\n'))).toBe(1);
    expect(s.consume(enc('data: b\n\ndata: c\n\n'))).toBe(2);
    expect(s.consume(enc('data: partial'))).toBe(0);
  });

  it('reset 清空扫描状态', () => {
    const s = new SseScanner();
    s.consume(enc('data: {"usage":{"prompt_tokens":1}}\n\n'));
    s.reset();
    expect(s.getUsage()).toBeNull();
    expect(s.getErrorFrame()).toBeNull();
  });

  describe('atBoundary（事件边界判定，心跳注入用）', () => {
    it('流开头是边界', () => {
      expect(new SseScanner().atBoundary()).toBe(true);
    });

    it('半截 data 行不是边界', () => {
      const s = new SseScanner();
      s.consume(enc('data: {"a":'));
      expect(s.atBoundary()).toBe(false);
    });

    it('行结束但事件未完不是边界（data 行 + 无空行）', () => {
      const s = new SseScanner();
      s.consume(enc('data: {"a":1}\n'));
      expect(s.atBoundary()).toBe(false);
      s.consume(enc('\n'));
      expect(s.atBoundary()).toBe(true);
    });

    it('完整事件后是边界', () => {
      const s = new SseScanner();
      s.consume(enc('data: {"a":1}\n\n'));
      expect(s.atBoundary()).toBe(true);
    });

    it('注释行（心跳帧）不破坏边界', () => {
      const s = new SseScanner();
      s.consume(enc(': keep-alive\n\n'));
      expect(s.atBoundary()).toBe(true);
    });

    it('跨 chunk 拆分的空行仍正确判定', () => {
      const s = new SseScanner();
      s.consume(enc('data: {"a":1}\n'));
      expect(s.atBoundary()).toBe(false);
      s.consume(enc('{'));
      expect(s.atBoundary()).toBe(false);
      s.consume(enc('\n'));
      expect(s.atBoundary()).toBe(false);
      s.consume(enc('\n'));
      expect(s.atBoundary()).toBe(true);
    });

    it('CRLF 换行按 \n 判定', () => {
      const s = new SseScanner();
      s.consume(enc('data: {"a":1}\r\n\r\n'));
      expect(s.atBoundary()).toBe(true);
    });

    it('reset 重置边界为 true', () => {
      const s = new SseScanner();
      s.consume(enc('data: {"a":'));
      expect(s.atBoundary()).toBe(false);
      s.reset();
      expect(s.atBoundary()).toBe(true);
    });
  });

  it('onErrorFrame 回调在捕获首个错误帧时触发', () => {
    const frames: { code: string }[] = [];
    const s = new SseScanner({ onErrorFrame: (frame) => frames.push(frame) });
    s.consume(enc('data: {"error":{"code":"rate_limited","message":"slow down"}}\n\n'));
    s.consume(enc('data: {"error":{"code":"other"}}\n\n'));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.code).toBe('rate_limited');
  });

  it('非错误帧不触发 onErrorFrame', () => {
    const frames: unknown[] = [];
    const s = new SseScanner({ onErrorFrame: (frame) => frames.push(frame) });
    s.consume(enc('data: {"usage":{"prompt_tokens":1}}\n\n'));
    expect(frames).toHaveLength(0);
  });
});
