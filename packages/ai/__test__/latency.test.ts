/**
 * §3.6 延迟测试（数据面预算的可执行形态；短时限+容差，AGENT.md §10.2）：
 *   1. TTFB：上游发出首帧后连接仍保持时，C 端必须已读到首块——证明逐块透传、
 *      不做「收完再转发」（若实现整流缓冲，本用例在读首块处超时失败）；
 *   2. 观察面不反噬：监听回调抛异常不破坏透传字节（fire-and-forget 异常隔离）；
 *   3. 吞吐界：500 帧小 SSE 在宽裕时限内完成中继（含 model-rewrite 开启的逐帧
 *      转换路径），防止「同步逐帧全量 JSON 往返」类回归无声混入。
 * 注：监听回调为同步 try/catch 派发（顺序语义；慢回调会拖慢帧循环——现网监听者
 * 均为 O(1) 计数器，强隔离改队列属契约变更须走 ADR，见 DESIGN 观察面注记）。
 */
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createAi, allowAllUrls } from '../src/index.js';

const startServer = (
  handler: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> =>
  new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });

const mk = (extra?: Parameters<typeof createAi>[0]) =>
  createAi(
    {
      retry: {
        maxAttempts: 1,
        baseDelayMs: 5,
        maxDelayMs: 10,
        jitterRatio: 0,
        deadlineMs: 10_000,
        emptyCompletionRetries: 0,
      },
      timeout: { connectMs: 2000, totalMs: 10_000 },
      stream: { heartbeatIdleMs: 60_000, firstByteTimeoutMs: 3000, inactivityTimeoutMs: 8000 },
      ...extra,
    },
    { guardUrl: allowAllUrls },
  );

const ch = (baseUrl: string) => ({ baseUrl, apiKey: 'sk-t', protocol: 'openai-compatible' });

const frame = (text: string, model = 'm'): string =>
  `data: {"id":"1","model":"${model}","choices":[{"index":0,"delta":{"content":"${text}"},"finish_reason":null}]}\n\n`;

describe('§3.6 延迟测试', () => {
  it('TTFB：首帧即出,连接未结束也能读到首块(不收完再转发)', async () => {
    let releaseRest: (() => void) | undefined;
    const s = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frame('a'));
      // 首帧之后挂住连接——若实现整流缓冲,C 端首块读取将等到这里
      new Promise<void>((r) => {
        releaseRest = r;
      }).then(() => {
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    try {
      const ai = mk();
      const { stream } = await ai.chatStream(ch(s.baseUrl), {
        model: 'm',
        messages: [],
        stream: true,
      });
      const reader = stream.getReader();
      const started = Date.now();
      const first = await reader.read();
      const firstChunkMs = Date.now() - started;
      expect(first.done).toBe(false);
      expect(new TextDecoder().decode(first.value)).toContain('"content":"a"');
      // 宽裕界:首块必须在连接挂住期间到达(上游尚未结束;5s 为 CI 抖动容差上界)
      expect(firstChunkMs).toBeLessThan(5000);
      releaseRest?.();
      await reader.cancel();
    } finally {
      await s.close();
    }
  });

  it('观察面不反噬:监听回调抛异常不破坏透传字节', async () => {
    const body = frame('x') + frame('y') + 'data: [DONE]\n\n';
    const s = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(body);
    });
    try {
      const ai = mk();
      let relayed = 0;
      const { stream, events } = await ai.chatStream(ch(s.baseUrl), {
        model: 'm',
        messages: [],
        stream: true,
      });
      events.subscribe(() => {
        relayed += 1;
        throw new Error('observer boom'); // 每次回调都抛——不得反噬数据面
      });
      const text = await new Response(stream).text();
      expect(text).toBe(body); // 逐字节保真
      expect(relayed).toBeGreaterThan(0); // 确认回调确实被调用过(异常路径真实走过)
    } finally {
      await s.close();
    }
  });

  it('吞吐界:500 帧中继(model-rewrite 开启的逐帧转换路径)在时限内完成', async () => {
    const parts: string[] = [];
    for (let i = 0; i < 500; i += 1) parts.push(frame(`c${i}`, 'real-name'));
    parts.push('data: [DONE]\n\n');
    const body = parts.join('');
    const s = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(body);
    });
    try {
      const ai = mk({ responseModelRewrite: true });
      const started = Date.now();
      const { stream } = await ai.chatStream(ch(s.baseUrl), {
        model: 'catalog',
        messages: [],
        stream: true,
      });
      const text = await new Response(stream).text();
      const wallMs = Date.now() - started;
      expect(text).toContain('"model":"catalog"');
      expect(text).not.toContain('real-name');
      // 宽裕界:500 帧 × ~130B,逐帧转换须远低于逐帧全量 JSON 往返的退化形态
      expect(wallMs).toBeLessThan(4000);
    } finally {
      await s.close();
    }
  });
});
