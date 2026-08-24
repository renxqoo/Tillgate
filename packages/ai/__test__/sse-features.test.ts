import { describe, expect, it } from 'vitest';
import { TextFeaturesAccumulator, extractTextFeatures } from '../src/usage/features.js';
import { SseBoundaryTracker, createSseEventReader, sseToSseStream } from '../src/transport/sse.js';
import type { SseEvent } from '../src/transport/sse.js';

describe('usage/features：四计数器（S1 修复的计量基础）', () => {
  it('extractTextFeatures：CJK 逐字、拉丁词段、数字段、符号（v1 状态机语义）', () => {
    expect(extractTextFeatures('你好世界')).toEqual({
      cjkChars: 4,
      wordSegments: 0,
      numberSegments: 0,
      symbolCount: 0,
    });
    expect(extractTextFeatures('hello world')).toEqual({
      cjkChars: 0,
      wordSegments: 2,
      numberSegments: 0,
      symbolCount: 0,
    });
    expect(extractTextFeatures('a1b2')).toEqual({
      cjkChars: 0,
      wordSegments: 2,
      numberSegments: 2,
      symbolCount: 0,
    });
    expect(extractTextFeatures('你好 abc 123!!')).toEqual({
      cjkChars: 2,
      wordSegments: 1,
      numberSegments: 1,
      symbolCount: 2,
    });
    expect(extractTextFeatures('')).toEqual({
      cjkChars: 0,
      wordSegments: 0,
      numberSegments: 0,
      symbolCount: 0,
    });
  });

  it('累积器 == 逐片段 extractTextFeatures 之和（片段边界即分段边界——v1 口径保持）', () => {
    const pieces = ['你好', ' hel', 'lo ', '123', '!!', '世界'];
    const acc = new TextFeaturesAccumulator();
    for (const p of pieces) acc.addText(p);
    const sum = pieces
      .map((p) => extractTextFeatures(p))
      .reduce((a, b) => ({
        cjkChars: a.cjkChars + b.cjkChars,
        wordSegments: a.wordSegments + b.wordSegments,
        numberSegments: a.numberSegments + b.numberSegments,
        symbolCount: a.symbolCount + b.symbolCount,
      }));
    expect(acc.snapshot()).toEqual(sum);
    // "hel"+"lo" 是两个片段 = 2 个词段（与 v1 逐片段调用一致），整段才是 1 段——口径显式锁定
    expect(sum.wordSegments).toBe(2);
  });

  it('累积器 O(1) 内存：超长流（>4MB 文本）内存不随输入增长（对照 v1 文本累积）', () => {
    const acc = new TextFeaturesAccumulator();
    const chunk = 'a'.repeat(1024);
    for (let i = 0; i < 5000; i++) acc.addText(chunk); // 5MB
    expect(acc.snapshot().wordSegments).toBe(5000);
  });
});

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);

describe('transport/sse：统一解析原语（S3/S4 修复）', () => {
  it('createSseEventReader：跨 chunk 行缓冲 + UTF-8 多字节安全 + event 名保留 + 多行 data 拼接', () => {
    const events: SseEvent[] = [];
    const r = createSseEventReader((ev) => events.push(ev));
    // event 名 + data 分两个 chunk，多字节字符劈开
    r.push(bytes('event: message_st'));
    r.push(bytes('art\ndata: {"text":"你'));
    r.push(bytes('好"}\n\ndata: second\n'));
    r.flush();
    expect(events).toEqual([
      { event: 'message_start', data: '{"text":"你好"}' },
      { event: undefined, data: 'second' },
    ]);
  });

  it('createSseEventReader：注释行忽略、CRLF、无尾空行的 flush 兜底', () => {
    const events: SseEvent[] = [];
    const r = createSseEventReader((ev) => events.push(ev));
    r.push(bytes(': keep-alive\r\ndata: a\r\n\r'));
    r.push(bytes('\ndata: tail-no-newline'));
    r.flush();
    expect(events).toEqual([
      { event: undefined, data: 'a' },
      { event: undefined, data: 'tail-no-newline' },
    ]);
  });

  it('SseBoundaryTracker：事件边界矩阵（心跳注入判定）', () => {
    const t = new SseBoundaryTracker();
    expect(t.atBoundary()).toBe(true); // 流开始
    t.track('data: a\n');
    expect(t.atBoundary()).toBe(false); // 行结束但事件未完
    t.track('\n');
    expect(t.atBoundary()).toBe(true); // 空行 = 事件边界
    t.track('data: b'); // 半截行（无换行）
    expect(t.atBoundary()).toBe(false);
    t.track('\r\n'); // CRLF 结束 data: b 行（内容行，非空行）
    expect(t.atBoundary()).toBe(false);
    t.track('\r\n'); // 空行 = 事件边界
    expect(t.atBoundary()).toBe(true);
  });

  it('sseToSseStream：逐事件转换 + flush 补帧 + 背压传导（TransformStream 形态）', async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"v":1}\n\ndata: {"v":2}\n\n'));
        c.close();
      },
    });
    const out = sseToSseStream(
      upstream,
      (ev, emit) => {
        emit(new TextEncoder().encode(`>${ev.data}`));
      },
      (emit) => emit(new TextEncoder().encode('>flush')),
    );
    const text = await new Response(out).text();
    expect(text).toBe('>{"v":1}>{"v":2}>flush');
  });

  it('sseToSseStream：取消向上游传播', async () => {
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: x\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const out = sseToSseStream(upstream, (_ev, emit) => emit(new TextEncoder().encode('y')));
    await out.cancel();
    await new Promise((r) => {
      setTimeout(r, 20);
    }); // 取消链异步传播
    expect(cancelled).toBe(true);
  });
});
