/**
 * 传输层深支（http-client / sse-parser / sse / relay-stream）：
 * SSRF 判定段全枚举、读体限长与 abort 联动、SSE 扫描器解析故障与特征累计、
 * relay flush 的四种终止语义与 model 改写尾行。不起外部网络——
 * 每个断言锁定一条守卫/终止分支（改判定即红）。
 */
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  isUnsafeIpv4,
  isUnsafeIpv6,
  assertSafeAddress,
  assertSafeUrlSync,
  fetchUpstream,
  readBody,
  readRawBody,
  allowAllUrls,
  BodyTooLargeError,
} from '../src/transport/http-client.js';
import { SseScanner } from '../src/transport/sse-parser.js';
import {
  createSseEventReader,
  openaiErrorFrame,
  DEFAULT_MAX_LINE_BYTES,
} from '../src/transport/sse.js';
import { relayStream } from '../src/transport/relay-stream.js';
import type { RelayStreamEvent } from '../src/transport/relay-stream.js';

const enc = new TextEncoder();
const b = (t: string) => enc.encode(t);

/** 恒拒绝守卫（策略注入面：整体替换内置 SSRF 门控） */
const rejectingGuard = async (): Promise<void> => {
  throw new Error('ssrf blocked by policy');
};

const startServer = (handler: (req: IncomingMessage, res: ServerResponse) => void) =>
  new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
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

// ─────────────────── SSRF 段判定表 ───────────────────

describe('isUnsafeIpv4：保留段全枚举（SSRF 机制表）', () => {
  const unsafe: string[] = [
    '0.1.2.3', // 0/8 本网络
    '10.1.2.3', // 10/8 私网
    '127.0.0.1', // 回环
    '169.254.169.254', // 链路本地（云 metadata）
    '172.16.0.1',
    '172.31.255.255', // 172.16/12
    '192.168.1.1', // 192.168/16
    '100.64.0.1',
    '100.127.255.255', // CGNAT
    '224.0.0.1',
    '255.255.255.255', // 组播/保留
  ];
  const safe: string[] = [
    '1.1.1.1',
    '8.8.8.8',
    '172.32.0.1',
    '100.63.0.1',
    '100.128.0.1',
    '172.15.0.1',
    '93.184.216.34',
  ];
  const invalid: string[] = ['256.1.1.1', '1.2.3', '1.2.3.4.5', 'a.b.c.d', '1.2.3.-1', ''];
  it.each(unsafe)('%s → 拦截', (ip) => expect(isUnsafeIpv4(ip), ip).toBe(true));
  it.each(safe)('%s → 放行', (ip) => expect(isUnsafeIpv4(ip), ip).toBe(false));
  it.each(invalid)('%s → 非法形态按拦截', (ip) => expect(isUnsafeIpv4(ip), ip).toBe(true));
});

describe('isUnsafeIpv6：保留段全枚举（含 IPv4-mapped 压缩形）', () => {
  const unsafe: string[] = [
    'fe80::1%eth0', // zone index
    '::',
    '::1', // 未指定/回环
    'fc00::1',
    'fd12:3456::1', // ULA
    'fe80::1',
    'fe90::',
    'fea0::',
    'feb0::', // 链路本地 fe80::/10
    'ff02::1', // 组播
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1', // mapped dotted
    '::ffff:7f00:1', // mapped 压缩 hex
    'FE80::1', // 大写归一
  ];
  const safe: string[] = ['2001:db8::1', '2606:4700::1111', '::ffff:1.1.1.1'];
  it.each(unsafe)('%s → 拦截', (ip) => expect(isUnsafeIpv6(ip), ip).toBe(true));
  it.each(safe)('%s → 放行', (ip) => expect(isUnsafeIpv6(ip), ip).toBe(false));
});

describe('assertSafeUrlSync：同步快速失败矩阵', () => {
  it('私网字面量 host 名 / allowLocal http / IPv6 字面量', () => {
    expect(() => assertSafeUrlSync('https://ip6-loopback/x')).toThrow(/blocked host/);
    expect(() => assertSafeUrlSync('https://192.168.0.1/x')).toThrow(/blocked address/);
    expect(() => assertSafeUrlSync('https://[fd00::1]/x')).toThrow(/blocked address/);
    expect(assertSafeUrlSync('http://192.168.0.1/x', { allowLocal: true }).hostname).toBe(
      '192.168.0.1',
    );
    expect(assertSafeUrlSync('https://[2001:db8::1]/x').hostname).toBe('[2001:db8::1]');
  });
});

// ─────────────────── fetchUpstream / 读体 ───────────────────

describe('fetchUpstream：错误分类与信号传播', () => {
  it('guard 拒绝原样上抛（不吞成 network）', async () => {
    const guard = rejectingGuard;
    await expect(
      fetchUpstream('https://x.test/', { method: 'GET' }, { connectMs: 100, guard }),
    ).rejects.toThrow('ssrf blocked by policy');
  });
  it('外部信号中止 → 原生 aborted（上层识别为取消）', async () => {
    const s = await startServer(() => {
      /* 收到请求但永不响应 */
    });
    try {
      const ctrl = new AbortController();
      const p = fetchUpstream(
        `${s.baseUrl}/hang`,
        { method: 'GET' },
        { connectMs: 5000, signal: ctrl.signal, guard: allowAllUrls },
      );
      setTimeout(() => ctrl.abort(), 60);
      await expect(p).rejects.toThrow('aborted');
    } finally {
      await s.close();
    }
  });
});

describe('readBody / readRawBody：限长与 abort 联动', () => {
  it('readBody：无 body → 空串；abort 中途 → 抛 aborted 不 hang（不再返回截断体）', async () => {
    expect(await readBody(new Response(null) as unknown as Response)).toBe('');
    let slowTimer: ReturnType<typeof setTimeout> | undefined;
    const slow = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(b('first'));
        slowTimer = setTimeout(() => {
          c.enqueue(b('second'));
          c.close();
        }, 200);
      },
      // abort 后 reader.cancel() 已关闭 controller：清掉延迟回调，否则它落在测试
      // 窗口外触发未处理 TypeError，让整门 vitest exit 1（间歇性 flake 根因）
      cancel() {
        clearTimeout(slowTimer);
      },
    });
    const ctrl = new AbortController();
    const p = readBody(new Response(slow) as unknown as Response, { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 30);
    // cancel 后 read 以 done 退出，读循环收尾按中止即错收口（上层归 canceled）
    await expect(p).rejects.toThrow('aborted');
  });
  it('readRawBody：无 body → 空字节；超限 → BodyTooLargeError；abort → 抛 aborted', async () => {
    expect((await readRawBody(new Response(null) as unknown as Response)).byteLength).toBe(0);
    const big = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(64));
      },
    });
    await expect(
      readRawBody(new Response(big) as unknown as Response, { maxBytes: 8 }),
    ).rejects.toThrow(BodyTooLargeError);
    let slowTimer: ReturnType<typeof setTimeout> | undefined;
    const slow = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2]));
        slowTimer = setTimeout(() => {
          c.enqueue(new Uint8Array([3]));
          c.close();
        }, 150);
      },
      cancel() {
        clearTimeout(slowTimer);
      },
    });
    const ctrl = new AbortController();
    const p = readRawBody(new Response(slow) as unknown as Response, { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 30);
    await expect(p).rejects.toThrow('aborted');
  });
});

// ─────────────────── SSE 扫描器与解析原语 ───────────────────

describe('SseScanner：解析故障与特征累计', () => {
  it('行超限 → broken 停扫（透传不受影响，后续 consume 计 0）', () => {
    const s = new SseScanner();
    expect(s.consume(b('data: {"usage":{"prompt_tokens":3}}\n\n'))).toBe(1);
    expect(s.consume(new Uint8Array(DEFAULT_MAX_LINE_BYTES + 16))).toBe(0); // 超 1MiB 无换行 → 抛内部异常转 broken
    expect(s.consume(b('data: {"b":2}\n\n'))).toBe(0); // broken 后不再计数
    expect(s.getUsage()).toEqual({ prompt_tokens: 3 }); // 故障前已扫到的 usage 保留
  });
  it('tool_calls 增量特征累计：name + arguments 进特征；completions text 字段也计', () => {
    const s = new SseScanner();
    s.consume(
      b(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"get_weather","arguments":"{\\"city\\":"}},{"index":1},{"function":7},7]}}]}\n\n',
      ),
    );
    s.consume(
      b(
        'data: {"choices":[{"text":"legacy"},{"delta":{"reasoning_content":"think"}},{"delta":{"content":"c"}},{"delta":7},7]}\n\n',
      ),
    );
    const f = s.getFeatures().snapshot();
    expect(f.wordSegments).toBeGreaterThanOrEqual(2); // get_weather + city 等词段
    expect(f.symbolCount).toBeGreaterThan(0); // JSON 标点
    expect(f.cjkChars).toBe(0);
  });
  it('usage:null 不覆盖真值；错误帧只回调一次；[DONE] 计事件', () => {
    const errors: unknown[] = [];
    const s = new SseScanner({ onErrorFrame: (frame) => errors.push(frame) });
    s.consume(b('data: {"usage":{"prompt_tokens":5}}\n\n'));
    s.consume(b('data: {"usage":null}\n\n'));
    expect(s.getUsage()).toEqual({ prompt_tokens: 5 });
    s.consume(b('data: {"error":{"code":"e1","message":"m"}}\n\n'));
    s.consume(b('data: {"error":{"code":"e2"}}\n\n'));
    expect(errors.length).toBe(1); // 只首个错误帧回调
    expect(s.getErrorFrame()).toMatchObject({ code: 'e1' });
    const t0 = s.getLastEventAt();
    s.consume(b('data: [DONE]\n\n'));
    expect(s.hasDone()).toBe(true);
    expect(s.getLastEventAt()).toBeGreaterThanOrEqual(t0);
    s.consume(b('data: not-json\n\n')); // 非 JSON 帧不计数不崩
    s.consume(b('data: 7\n\n')); // 非 JSON 数字帧
    s.consume(b('data: "str"\n\n')); // JSON 非对象
  });
  it('终止帧判定：choices[].finish_reason 存在即 terminal（含非对象 choice 容错）', () => {
    const s = new SseScanner();
    s.consume(b('data: {"choices":[{"delta":{}}]}\n\n'));
    expect(s.hasTerminalFrame()).toBe(false);
    s.consume(b('data: {"choices":[7,{"finish_reason":"stop"},7]}\n\n'));
    expect(s.hasTerminalFrame()).toBe(true);
  });
});

describe('transport/sse：行上界与错误帧序列化', () => {
  it('超 maxLineBytes 抛英文错误且缓冲清空（可复用）', () => {
    const r = createSseEventReader(() => {}, { maxLineBytes: 16 });
    expect(() => r.push(b('data: aaaaaaaaaaaaaaaaaaaaa'))).toThrow(
      /SSE line exceeds maximum of 16 bytes/,
    ); // 无换行的半截行才计 bufferBytes
    r.push(b('data: ok\n\n')); // 清空后可继续
    const events: string[] = [];
    const r2 = createSseEventReader((ev) => events.push(ev.data));
    r2.push(b('data: ok\n\n'));
    expect(events).toEqual(['ok']);
  });
  it('openaiErrorFrame：code/type/message 序列化', () => {
    expect(new TextDecoder().decode(openaiErrorFrame({ code: 'c', type: 't', detail: 'd' }))).toBe(
      'data: {"error":{"code":"c","type":"t","message":"d"}}\n\n',
    );
  });
});

// ─────────────────── relay-stream：flush 终止语义 ───────────────────

describe('relayStream：flush 四种终止与改写尾行', () => {
  it('终止帧到达但缺 [DONE] → 安全补哨兵（doneSentinel=false 语义保留）', async () => {
    const events: RelayStreamEvent[] = [];
    const handle = relayStream(
      new ReadableStream({
        start(c) {
          c.enqueue(b('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
          c.close();
        },
      }),
      { heartbeatIdleMs: 60_000, inactivityTimeoutMs: 60_000 },
    );
    handle.onEvent((e) => events.push(e));
    const text = await new Response(handle.stream).text();
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true); // 补齐恰好一个哨兵
    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({ doneSentinel: false, terminalFrame: true, terminated: undefined });
  });
  it('错误帧后 EOF（无哨兵无终止帧）→ 补 [DONE] + upstream_error 终止', async () => {
    const events: RelayStreamEvent[] = [];
    const handle = relayStream(
      new ReadableStream({
        start(c) {
          c.enqueue(b('data: {"error":{"code":"boom","message":"x"}}\n\n'));
          c.close();
        },
      }),
      { heartbeatIdleMs: 60_000, inactivityTimeoutMs: 60_000 },
    );
    handle.onEvent((e) => events.push(e));
    const text = await new Response(handle.stream).text();
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(events.some((e) => e.type === 'aborted' && e.reason === 'upstream_error')).toBe(true);
    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({ terminated: 'upstream_error' });
  });
  it('rewriteModel：尾行半截在 flush 补吐（改写字节计入 bytesRelayed）', async () => {
    const events: RelayStreamEvent[] = [];
    const handle = relayStream(
      // 终止帧完整到达（\n\n 结束），随后半截行无换行——改写器持有、flush 才吐
      new ReadableStream({
        start(c) {
          c.enqueue(
            b('data: {"model":"real-name","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'),
          );
          c.enqueue(b('data: {"model":"real-name","choices":[{"delta":{"content":"x"}}]}'));
          c.close();
        },
      }),
      { heartbeatIdleMs: 60_000, inactivityTimeoutMs: 60_000, rewriteModel: 'catalog-name' },
    );
    handle.onEvent((e) => events.push(e));
    const text = await new Response(handle.stream).text();
    expect(text).not.toContain('real-name');
    expect((text.match(/"model":"catalog-name"/g) ?? []).length).toBe(2); // 两帧都被改写（含 flush 尾行）
    const done = events.find((e) => e.type === 'done');
    // 出站字节 = 改写后全数据（含 flush 尾行），哨兵 [DONE] 不计入 bytesRelayed
    if (done?.type === 'done') {
      expect(done.bytesRelayed).toBe(text.length - 'data: [DONE]\n\n'.length);
    }
  });
  it('完成语义后客户端断开：错误帧已完成 → upstream_error 而非 client_disconnect（#6649 同类）', async () => {
    const events: RelayStreamEvent[] = [];
    const handle = relayStream(
      new ReadableStream({
        start(c) {
          c.enqueue(
            b('data: {"error":{"code":"late","message":"m"}}\n\ndata: [DONE]\n\n'),
          ); /* 保持打开 */
        },
      }),
      { heartbeatIdleMs: 60_000, inactivityTimeoutMs: 60_000 },
    );
    handle.onEvent((e) => events.push(e));
    const reader = handle.stream.getReader();
    await reader.read(); // 数据流经 transform（error + DONE 已处理）
    await reader.cancel(); // 客户端随后断开
    await new Promise((r) => {
      setTimeout(r, 30);
    });
    expect(events.some((e) => e.type === 'aborted' && e.reason === 'upstream_error')).toBe(true);
    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({ terminated: 'upstream_error', doneSentinel: true });
  });
  it('未完成即断开 → client_disconnect（usage 留痕供估算结算）', async () => {
    const events: RelayStreamEvent[] = [];
    const handle = relayStream(
      new ReadableStream({
        start(c) {
          c.enqueue(b('data: {"usage":{"prompt_tokens":9}}\n\n')); /* 打开 */
        },
      }),
      { heartbeatIdleMs: 60_000, inactivityTimeoutMs: 60_000 },
    );
    handle.onEvent((e) => events.push(e));
    const reader = handle.stream.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => {
      setTimeout(r, 30);
    });
    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({ terminated: 'client_disconnect' });
    if (done?.type === 'done') expect(done.usage).toEqual({ prompt_tokens: 9 });
  });
});

describe('assertSafeAddress（拨号层原语——非 IP 文本防御对称）', () => {
  it('八进制/十进制/任意文本一律拒绝；规范公网 IP 放行', () => {
    expect(() => assertSafeAddress('0177.0.0.1')).toThrow(/blocked address/); // Number('0177')=177 误判公网
    expect(() => assertSafeAddress('2130706433')).toThrow(/blocked address/);
    expect(() => assertSafeAddress('not-an-ip')).toThrow(/blocked address/);
    expect(() => assertSafeAddress('10.0.0.5')).toThrow(/blocked address/);
    expect(() => assertSafeAddress('::ffff:10.0.0.1')).toThrow(/blocked address/);
    expect(assertSafeAddress('93.184.216.34')).toBeUndefined();
    expect(assertSafeAddress('2606:4700::1111')).toBeUndefined();
    // allowLocal = 全放行（测试/本地调试语义）
    expect(assertSafeAddress('127.0.0.1', { allowLocal: true })).toBeUndefined();
  });
});
