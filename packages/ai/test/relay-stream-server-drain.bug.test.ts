import { describe, expect, it } from 'vitest';
import { relayStream, type RelayStreamEvent } from '../src/transport/relay-stream.js';
import { ServerDrainAbort } from '../src/errors/server-drain.js';

/**
 * drain 中止计费归属回归（审计 P0-1 流侧）：服务端 drain 中止在途流时，
 * 终态必须归类 server_draining（服务端责任 → 预扣释放），而不是
 * request_cancelled（用户侧取消 → 按透传字节估算结算）。
 */
describe('relayStream — 服务端 drain 中止的分类', () => {
  it('ServerDrainAbort 标记中止 → terminated=server_draining', async () => {
    const ctrl = new AbortController();
    // 上游挂起不吐数据（半死连接场景）
    const upstream = new ReadableStream<Uint8Array>({ start() {} });
    const handle = relayStream(upstream, {
      heartbeatIdleMs: 60_000,
      inactivityTimeoutMs: 60_000,
      signal: ctrl.signal,
    });
    const events: RelayStreamEvent[] = [];
    handle.onEvent((e) => events.push(e));
    ctrl.abort(new ServerDrainAbort());
    await new Promise((r) => setTimeout(r, 30));
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect(done && done.type === 'done' ? done.terminated : undefined).toBe('server_draining');
  });

  it('普通 abort（用户取消）→ terminated=request_cancelled（语义不回退）', async () => {
    const ctrl = new AbortController();
    const upstream = new ReadableStream<Uint8Array>({ start() {} });
    const handle = relayStream(upstream, {
      heartbeatIdleMs: 60_000,
      inactivityTimeoutMs: 60_000,
      signal: ctrl.signal,
    });
    const events: RelayStreamEvent[] = [];
    handle.onEvent((e) => events.push(e));
    ctrl.abort();
    await new Promise((r) => setTimeout(r, 30));
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' ? done.terminated : undefined).toBe('request_cancelled');
  });
});
