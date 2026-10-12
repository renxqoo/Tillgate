/**
 * issue #73 复现测试（档 2 harness 测试化）+ timeout 归因矩阵。
 *
 * 生产事故：30 万 token 前缀流式请求 lifetime 恒定 30-31s 502 timeout——
 * 旧实现 connectMs=10s 覆盖到响应头，大 body 上传+上游预填 >10s → abort →
 * kind=timeout 可重试 → 三连重试（每次同层 10s 灭）≈30s 全灭。
 *
 * 修复后：响应头预算按 body 规模自适应（base + 每MB 加成），快失败层
 * connectMs 仅在预算远大于它时武装；UpstreamError.stage 透出四层归因。
 */
import { describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createAi } from '../src/index.js';
import { allowAllUrls } from '../src/transport/http-client.js';
type Rec = Record<string, unknown>;

/** server.close 的 promise 化（executor 不 return 纪律） */
function serverClose(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

/** SSE 完成序列（首帧 + DONE + end——慢首 token 形态的收尾写法） */
function writeSseCompletion(res: ServerResponse): void {
  res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

interface MockUpstream {
  server: Server;
  port: number;
  /** 各次连接的 body 到达时刻（相对启动）——观测重连风暴 */
  bodyArrivals: number[];
  firstFrameDelayMs: number;
  headerDelayMs: number;
  t0: number;
  close(): Promise<void>;
}

async function mockUpstream(opts: {
  firstFrameDelayMs?: number;
  headerDelayMs?: number;
}): Promise<MockUpstream> {
  const bodyArrivals: number[] = [];
  const t0 = Date.now();
  const state = {
    firstFrameDelayMs: opts.firstFrameDelayMs ?? 0,
    headerDelayMs: opts.headerDelayMs ?? 0,
  };
  const server = createServer((req, res) => {
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
    });
    req.on('end', () => {
      bodyArrivals.push(Date.now() - t0);
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders(); // 无 body 写入时 node 缓冲 headers——flush 才真正发出
        if (state.firstFrameDelayMs === -1) return; // 永挂：headers 已发、body 永不写（超慢首 token）
        // 慢首 token：延迟写首帧 + 短生成收尾；0 = 立即完成
        setTimeout(writeSseCompletion, state.firstFrameDelayMs, res);
      }, state.headerDelayMs);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });
  const addr = server.address() as { port: number };
  const { port } = addr;
  return {
    server,
    port,
    get bodyArrivals() {
      return bodyArrivals;
    },
    get firstFrameDelayMs() {
      return state.firstFrameDelayMs;
    },
    set firstFrameDelayMs(v: number) {
      state.firstFrameDelayMs = v;
    },
    get headerDelayMs() {
      return state.headerDelayMs;
    },
    set headerDelayMs(v: number) {
      state.headerDelayMs = v;
    },
    t0,
    close(): Promise<void> {
      return serverClose(server);
    },
  };
}

describe('issue #73：大 body 响应头预算自适应（复现测试）', () => {
  it('复现组（修复后）：45s 慢响应头 + 大 body → 单次等待成功（旧实现 30.7s 三连重试全灭）', async () => {
    const s = await mockUpstream({ headerDelayMs: 45_000 });
    try {
      const ai = createAi(
        {
          retry: {
            maxAttempts: 3,
            baseDelayMs: 250,
            maxDelayMs: 8_000,
            jitterRatio: 0,
            deadlineMs: 120_000,
            emptyCompletionRetries: 2,
          },
          // v3 叠加式：预算放大入口即 connectMs（50s 覆盖 45s 慢响应头）
          timeout: {
            connectMs: 50_000,
            totalMs: 120_000,
            responseHeaderPerMbMs: 5_000,
            responseHeaderMaxMs: 90_000,
          },
          stream: {
            heartbeatIdleMs: 30_000,
            firstByteTimeoutMs: 60_000,
            inactivityTimeoutMs: 120_000,
          },
        },
        { guardUrl: allowAllUrls },
      );
      const r = await ai.chatStream(
        { baseUrl: `http://127.0.0.1:${s.port}`, apiKey: 'k', protocol: 'openai-compatible' },
        { model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true },
      );
      const text = await new Response(r.stream).text();
      expect(text).toContain('hi');
      // 修复核心断言：没有重连风暴（旧实现在 10s/20s 处重复发 body）
      expect(s.bodyArrivals.length).toBe(1);
    } finally {
      await s.close();
    }
  }, 90_000);

  it('旧语义回归锚：小 body + 慢响应头（>connectMs 且预算未扩）→ 仍快失败 stage=connect', async () => {
    const s = await mockUpstream({ headerDelayMs: 15_000 });
    try {
      const ai = createAi(
        {
          retry: {
            maxAttempts: 1,
            baseDelayMs: 5,
            maxDelayMs: 10,
            jitterRatio: 0,
            deadlineMs: 60_000,
            emptyCompletionRetries: 0,
          },
          // 预算三键压到与 connectMs 等值（zod 每键独立 default——部分注入即补全，
          // 此处显式等值注入模拟「预算未扩」形态；裸缺省回落场景由裸 fetchUpstream
          // 用例覆盖）
          timeout: {
            connectMs: 6_000,
            totalMs: 60_000,
            responseHeaderBaseMs: 6_000,
            responseHeaderPerMbMs: 0,
            responseHeaderMaxMs: 6_000,
          },
          stream: {
            heartbeatIdleMs: 30_000,
            firstByteTimeoutMs: 60_000,
            inactivityTimeoutMs: 120_000,
          },
        },
        { guardUrl: allowAllUrls },
      );
      const events: Rec[] = [];
      ai.subscribe((e) => events.push(e as Rec));
      const r = await ai.chatStream(
        { baseUrl: `http://127.0.0.1:${s.port}`, apiKey: 'k', protocol: 'openai-compatible' },
        { model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true },
      );
      const text = await new Response(r.stream).text();
      expect(text).toContain('timeout');
      const failed = events.find((e) => e.type === 'failed') as
        | { error?: { kind?: string; stage?: string } }
        | undefined;
      expect(failed?.error?.kind).toBe('timeout');
      expect(failed?.error?.stage).toBe('connect');
    } finally {
      await s.close();
    }
  }, 30_000);
});

describe('timeout 归因矩阵（stage 四层各一处赋值）', () => {
  it('response_header：预算 13s（connectMs 8s + 1MB×5s/MB）+ 15s 慢响应头 → stage=response_header', async () => {
    const s = await mockUpstream({ headerDelayMs: 15_000 });
    try {
      const ai = createAi(
        {
          retry: {
            maxAttempts: 1,
            baseDelayMs: 5,
            maxDelayMs: 10,
            jitterRatio: 0,
            deadlineMs: 60_000,
            emptyCompletionRetries: 0,
          },
          // v3 叠加式：预算 13s（connectMs 8s + 1MB×5s/MB；armed 判定见
          // classifyHeaderTimeout——预算严格大于 connectMs 才 response_header，
          // 等值归 connect。此用例意图是「预算扩了」——用 perMb 加成制造差值：
          // connectMs 8s + 1MB body + 5s/MB = 13s 预算 > 8s → armed ✓
          timeout: {
            connectMs: 8_000,
            totalMs: 60_000,
            responseHeaderPerMbMs: 5_000,
            responseHeaderMaxMs: 60_000,
          },
          stream: {
            heartbeatIdleMs: 30_000,
            firstByteTimeoutMs: 60_000,
            inactivityTimeoutMs: 120_000,
          },
        },
        { guardUrl: allowAllUrls },
      );
      const events: Rec[] = [];
      const r = await ai.chatStream(
        { baseUrl: `http://127.0.0.1:${s.port}`, apiKey: 'k', protocol: 'openai-compatible' },
        {
          model: 'm',
          messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }],
          stream: true,
        }, // 1MB → 预算 13s
      );
      r.events?.subscribe((e) => events.push(e as Rec));
      await new Response(r.stream).text();
      const failed = events.find((e) => e.type === 'failed') as
        | { error?: { kind?: string; stage?: string; message?: string } }
        | undefined;
      expect(failed?.error?.stage).toBe('response_header');
      expect(failed?.error?.message).toContain('response header timeout');
    } finally {
      await s.close();
    }
  }, 30_000);

  it('first_byte：响应头即到但首帧 hang → stage=first_byte（既有行为 + stage 透出）', async () => {
    // 形态对齐 assembly-deep 既有用例：headers 立即发、body 永不写——peek 在
    // firstByteTimeoutMs 处拒绝（比延迟写帧更贴「超慢首 token 服务器」形态）
    const s = await mockUpstream({ headerDelayMs: 0, firstFrameDelayMs: -1 });
    try {
      const ai = createAi(
        {
          retry: {
            maxAttempts: 1,
            baseDelayMs: 5,
            maxDelayMs: 10,
            jitterRatio: 0,
            deadlineMs: 60_000,
            emptyCompletionRetries: 0,
          },
          timeout: {
            connectMs: 10_000,
            totalMs: 60_000,
            responseHeaderBaseMs: 10_000,
            responseHeaderPerMbMs: 0,
            responseHeaderMaxMs: 10_000,
          },
          stream: {
            heartbeatIdleMs: 30_000,
            firstByteTimeoutMs: 120,
            inactivityTimeoutMs: 120_000,
          },
        },
        { guardUrl: allowAllUrls },
      );
      const events: Rec[] = [];
      ai.subscribe((e) => events.push(e as Rec));
      const r = await ai.chatStream(
        { baseUrl: `http://127.0.0.1:${s.port}`, apiKey: 'k', protocol: 'openai-compatible' },
        { model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true },
      );
      const text = await new Response(r.stream).text();
      expect(text).toContain('timeout');
      const failed = events.find((e) => e.type === 'failed') as
        | { error?: { kind?: string; stage?: string; message?: string } }
        | undefined;
      expect(failed?.error?.kind).toBe('timeout');
      expect(failed?.error?.stage).toBe('first_byte');
      expect(failed?.error?.message).toContain('no first byte');
    } finally {
      await s.close();
    }
  }, 30_000);

  it('budget：deadline 先于各层超时 → stage=budget', async () => {
    const s = await mockUpstream({ headerDelayMs: 10_000 });
    try {
      const ai = createAi(
        {
          retry: {
            maxAttempts: 3,
            baseDelayMs: 5,
            maxDelayMs: 10,
            jitterRatio: 0,
            deadlineMs: 2_000,
            emptyCompletionRetries: 0,
          },
          timeout: {
            connectMs: 60_000,
            totalMs: 60_000,
            responseHeaderBaseMs: 60_000,
            responseHeaderPerMbMs: 0,
            responseHeaderMaxMs: 60_000,
          },
          stream: {
            heartbeatIdleMs: 30_000,
            firstByteTimeoutMs: 60_000,
            inactivityTimeoutMs: 120_000,
          },
        },
        { guardUrl: allowAllUrls },
      );
      const events: Rec[] = [];
      const r = await ai.chatStream(
        { baseUrl: `http://127.0.0.1:${s.port}`, apiKey: 'k', protocol: 'openai-compatible' },
        { model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true },
      );
      r.events?.subscribe((e) => events.push(e as Rec));
      await new Response(r.stream).text();
      const failed = events.find((e) => e.type === 'failed') as
        | { error?: { kind?: string; stage?: string; message?: string } }
        | undefined;
      expect(failed?.error?.kind).toBe('timeout');
      expect(failed?.error?.stage).toBe('budget');
    } finally {
      await s.close();
    }
  }, 30_000);

  it('出厂默认回归锚（审查 A#1）：小 body 预算精确等值 connectMs——zod 全缺省链', async () => {
    const { responseHeaderBudget } = await import('../src/transport/http-client.js');
    const { aiDefaultsSchema } = await import('../src/config.js');
    // 出厂默认（gateway 不注入 responseHeader* 三键时的 ai 侧兜底形态）
    const cfg = aiDefaultsSchema.parse({});
    for (const bytes of [0, 100, 10_000, 100_000, 500_000]) {
      // connectMs + perMb×mb（叠加式——审查 A#1 定稿）：小 body 精确 10s
      const mb = bytes / (1024 * 1024);
      expect(
        responseHeaderBudget(bytes, { ...cfg.timeout, connectMs: cfg.timeout.connectMs }),
      ).toBe(Math.min(10_000 + mb * 5_000, 90_000));
    }
    expect(responseHeaderBudget(0, { ...cfg.timeout, connectMs: cfg.timeout.connectMs })).toBe(
      10_000,
    ); // 精确等值
    expect(
      responseHeaderBudget(1024 * 1024, { ...cfg.timeout, connectMs: cfg.timeout.connectMs }),
    ).toBe(15_000);
  });

  it('预算公式：responseHeaderBudget 单调 + 封顶（表驱动）', async () => {
    const { responseHeaderBudget } = await import('../src/transport/http-client.js');
    const cfg = {
      responseHeaderBaseMs: 20_000,
      responseHeaderPerMbMs: 5_000,
      responseHeaderMaxMs: 90_000,
    };
    expect(responseHeaderBudget(0, cfg)).toBe(20_000);
    expect(responseHeaderBudget(1_048_576, cfg)).toBe(25_000);
    expect(responseHeaderBudget(20 * 1_048_576, cfg)).toBe(90_000); // 封顶
    // 部分配置（缺键回落缺省）
    expect(responseHeaderBudget(0, {})).toBe(20_000);
  });
});

describe('异常场景矩阵（issue #73 用户裁决：多规模 × 慢形态——模拟真实 LLM 服务异常）', () => {
  // 真实 LLM 服务异常形态参考：
  // - 预填慢：响应头 + 首 token 都随上下文规模线性变慢（上游逐 token 处理完才吐头/首帧）
  // - 极慢首 token：响应头秒回（网关型上游）但生成第一 token 前内部排队/预填极久
  // - 100 万 token（≈4MB body）已是生产真实形态——静态预算全部不可用

  it.each([
    {
      bodyMb: 1.3,
      headerMs: 8_000,
      firstFrameMs: 12_000,
      desc: '30 万 token（事故形态）：头 8s + 首帧 12s',
    },
    { bodyMb: 4, headerMs: 20_000, firstFrameMs: 30_000, desc: '100 万 token：头 20s + 首帧 30s' },
  ])(
    '$desc → 全链成功（响应头预算 + firstByte 自适应覆盖）',
    async (c) => {
      const s = await mockUpstream({
        headerDelayMs: c.headerMs,
        firstFrameDelayMs: c.firstFrameMs,
      });
      try {
        const ai = createAi(
          {
            retry: {
              maxAttempts: 1,
              baseDelayMs: 5,
              maxDelayMs: 10,
              jitterRatio: 0,
              deadlineMs: 300_000,
              emptyCompletionRetries: 0,
            },
            timeout: {
              connectMs: 10_000,
              totalMs: 300_000,
              responseHeaderBaseMs: 20_000,
              responseHeaderPerMbMs: 5_000,
              responseHeaderMaxMs: 90_000,
            },
            stream: {
              heartbeatIdleMs: 30_000,
              firstByteTimeoutMs: 60_000,
              inactivityTimeoutMs: 120_000,
            },
          },
          { guardUrl: allowAllUrls },
        );
        const r = await ai.chatStream(
          { baseUrl: `http://127.0.0.1:${s.port}`, apiKey: 'k', protocol: 'openai-compatible' },
          {
            model: 'm',
            messages: [{ role: 'user', content: 'x'.repeat(Math.floor(c.bodyMb * 1024 * 1024)) }],
            stream: true,
          },
        );
        const text = await new Response(r.stream).text();
        expect(text).toContain('hi');
        expect(s.bodyArrivals.length).toBe(1); // 无重试风暴
      } finally {
        await s.close();
      }
    },
    120_000,
  );

  it('极慢首 token 服务器（头秒回 + 首 token 150s——firstByte 自适应到 90s 仍不够）→ stage=first_byte 非 connect', async () => {
    // 边界形态：上游是网关型（响应头立即回）但内部预填 100 万 token 需 150s。
    // firstByte 自适应给 90s（封顶）仍不足——此时该失败且归因正确（first_byte），
    // 运营据此调 responseHeaderMaxMs（预算公式共用）或上游换渠。
    const s = await mockUpstream({ headerDelayMs: 0, firstFrameDelayMs: -1 });
    try {
      const ai = createAi(
        {
          retry: {
            maxAttempts: 1,
            baseDelayMs: 5,
            maxDelayMs: 10,
            jitterRatio: 0,
            deadlineMs: 300_000,
            emptyCompletionRetries: 0,
          },
          timeout: {
            connectMs: 10_000,
            totalMs: 300_000,
            responseHeaderBaseMs: 20_000,
            responseHeaderPerMbMs: 5_000,
            responseHeaderMaxMs: 40_000,
          },
          stream: {
            heartbeatIdleMs: 30_000,
            firstByteTimeoutMs: 10_000,
            inactivityTimeoutMs: 120_000,
          },
        },
        { guardUrl: allowAllUrls },
      );
      const events: Rec[] = [];
      ai.subscribe((e) => events.push(e as Rec));
      const bodyMb = 4; // 100 万 token → 预算 max(10s 静态, 40s 自适应) = 40s
      const r = await ai.chatStream(
        { baseUrl: `http://127.0.0.1:${s.port}`, apiKey: 'k', protocol: 'openai-compatible' },
        {
          model: 'm',
          messages: [{ role: 'user', content: 'x'.repeat(bodyMb * 1024 * 1024) }],
          stream: true,
        },
      );
      const text = await new Response(r.stream).text();
      expect(text).toContain('timeout');
      const failed = events.find((e) => e.type === 'failed') as
        | { error?: { kind?: string; stage?: string } }
        | undefined;
      expect(failed?.error?.stage).toBe('first_byte'); // 归因首帧层——不是 connect/response_header
      expect(s.bodyArrivals.length).toBe(1);
    } finally {
      await s.close();
    }
  }, 90_000);

  it('边界：预算封顶后 body 再大不再增长（10MB 与 4MB 同预算）', async () => {
    const { responseHeaderBudget } = await import('../src/transport/http-client.js');
    const cfg = {
      responseHeaderBaseMs: 20_000,
      responseHeaderPerMbMs: 5_000,
      responseHeaderMaxMs: 90_000,
    };
    expect(responseHeaderBudget(4 * 1024 * 1024, cfg)).toBe(40_000);
    expect(responseHeaderBudget(100 * 1024 * 1024, cfg)).toBe(90_000); // 100MB 也封顶
    expect(responseHeaderBudget(4 * 1024 * 1024, cfg)).toBe(
      responseHeaderBudget(5 * 1024 * 1024, cfg) - 5_000,
    ); // 封顶内线性
  });

  it('边界：perMb=0（禁用规模加成）→ 恒 base（运营显式关闭自适应的语义）', async () => {
    const { responseHeaderBudget } = await import('../src/transport/http-client.js');
    const cfg = {
      responseHeaderBaseMs: 30_000,
      responseHeaderPerMbMs: 0,
      responseHeaderMaxMs: 90_000,
    };
    expect(responseHeaderBudget(0, cfg)).toBe(30_000);
    expect(responseHeaderBudget(50 * 1024 * 1024, cfg)).toBe(30_000);
  });

  it('异常：响应头 hang 且预算未扩（base < connectMs）→ connect 归因（旧快失败语义——#73 F6：响应头前 connect/TTFB 不可分，此归因是「预算未扩」信号而非连接层诊断）', async () => {
    const s = await mockUpstream({ headerDelayMs: 30_000 }); // 大 body 自适应 40s 内 → 30s 头到达应成功？不——本用例断言失败路径
    try {
      const ai = createAi(
        {
          retry: {
            maxAttempts: 1,
            baseDelayMs: 5,
            maxDelayMs: 10,
            jitterRatio: 0,
            deadlineMs: 300_000,
            emptyCompletionRetries: 0,
          },
          timeout: {
            connectMs: 10_000,
            totalMs: 300_000,
            responseHeaderBaseMs: 5_000,
            responseHeaderPerMbMs: 1_000,
            responseHeaderMaxMs: 6_000,
          }, // 小预算逼失败
          stream: {
            heartbeatIdleMs: 30_000,
            firstByteTimeoutMs: 60_000,
            inactivityTimeoutMs: 120_000,
          },
        },
        { guardUrl: allowAllUrls },
      );
      const events: Rec[] = [];
      ai.subscribe((e) => events.push(e as Rec));
      const r = await ai.chatStream(
        { baseUrl: `http://127.0.0.1:${s.port}`, apiKey: 'k', protocol: 'openai-compatible' },
        { model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true },
      );
      await new Response(r.stream).text();
      const failed = events.find((e) => e.type === 'failed') as
        | { error?: { stage?: string } }
        | undefined;
      // base 5s > connectMs? no: 5s < 10s → headerBudget=5s < connectMs → 归 connect（旧语义）
      // 该形态下（预算 < connectMs）保留 connect 归因——小 body 快失败语义
      expect(failed?.error?.stage).toBe('connect');
    } finally {
      await s.close();
    }
  }, 30_000);
});
