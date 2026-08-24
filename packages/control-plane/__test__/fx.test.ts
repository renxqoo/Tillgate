/**
 * fx 用例（v1 fx.test.ts 服务级用例等价迁移，fetch 全 mock 不打真 ECB）：
 * 冷启动懒拉 / TTL 跳过 / force 绕过 / 点差不叠覆盖 / 覆盖冻结与清除 / 校验拒绝 / 拉取失败降级。
 */
import { describe, expect, it } from 'vitest';
import { defined } from './defined';
import { fxState } from '../src/application/fx/fx-state';
import { refreshFx } from '../src/application/fx/refresh-fx';
import { setFxOverride } from '../src/application/fx/set-fx-override';
import { clearFxOverride } from '../src/application/fx/clear-fx-override';
import { setFxBuffer } from '../src/application/fx/set-fx-buffer';
import type { FxDeps } from '../src/application/fx/fx-shared';
import { adminCtx, createMemoryAudit, createMemoryDb, createMemoryFxStore } from './memory';

function ecbFetch(rate: number | 'fail', calls: { n: number } = { n: 0 }): typeof fetch {
  return (async () => {
    calls.n += 1;
    if (rate === 'fail') return new Response('boom', { status: 500 });
    return new Response(JSON.stringify({ rates: { CNY: rate } }), { status: 200 });
  }) as typeof fetch;
}

function setup(fetchImpl: typeof fetch) {
  const db = createMemoryDb();
  const fx = createMemoryFxStore();
  const audit = createMemoryAudit();
  const deps: FxDeps = {
    db,
    stores: { fx: fx.store },
    audit: audit.sink,
    env: {
      sourceUrl: 'https://api.frankfurter.app/latest?from=USD&to=CNY',
      autoTtlMs: 4 * 60 * 60 * 1000,
      fetchTimeoutMs: 10_000,
      fetch: fetchImpl,
    },
  };
  return { deps, fx, audit };
}

describe('fx 状态与懒拉', () => {
  it('冷启动懒拉落 auto 行 + 缓存视图；TTL 内不重复拉；force 绕过', async () => {
    const calls = { n: 0 };
    const { deps, fx } = setup(ecbFetch(7.21, calls));
    const s1 = await fxState(deps);
    expect(s1).toMatchObject({
      baseRate: '7.21',
      source: 'ecb',
      mode: 'auto',
      effectiveRate: '7.21',
    });
    expect(calls.n).toBe(1);
    expect(fx.rates.at(-1)).toMatchObject({ rate: '7.21', source: 'ecb', mode: 'auto' });
    expect(s1.fxRateId).toBe(defined(fx.rates.at(-1)).id);

    // TTL 内第二次 state 不再拉；非强制 refresh 同样早退
    await fxState(deps);
    await refreshFx(deps, { ctx: adminCtx(), force: false });
    expect(calls.n).toBe(1);

    // force 刷新绕过 TTL
    await refreshFx(deps, { ctx: adminCtx(), force: true });
    expect(calls.n).toBe(2);
  });

  it('点差：effective = base ×(1+buffer/100)；覆盖态不叠点差', async () => {
    const { deps } = setup(ecbFetch(7.2));
    await fxState(deps);
    const buffered = await setFxBuffer(deps, { ctx: adminCtx(), bufferPct: '2' });
    expect(Number(buffered.effectiveRate)).toBeCloseTo(7.344, 8);
    expect(buffered.baseRate).toBe('7.2'); // 基准不动——点差只进预填

    const overridden = await setFxOverride(deps, { ctx: adminCtx(), rate: '7.5' });
    expect(overridden).toMatchObject({ baseRate: '7.5', effectiveRate: '7.5', source: 'manual' });

    const cleared = await clearFxOverride(deps, { ctx: adminCtx() });
    expect(cleared).toMatchObject({ mode: 'auto', source: 'ecb' });
  });

  it('manual 行记录操作管理员；覆盖清除后立即补 auto 行（失败容忍）', async () => {
    const { deps, fx } = setup(ecbFetch(7.2));
    await fxState(deps); // 初始懒拉落第一根 auto 行（v1 流程）
    await setFxOverride(deps, { ctx: adminCtx(9), rate: '7.5' });
    expect(fx.rates.at(-1)).toMatchObject({ mode: 'override', operatorAdminId: 9 });
    await clearFxOverride(deps, { ctx: adminCtx(9) });
    expect(fx.rates.filter((r) => r.mode === 'auto')).toHaveLength(2); // 清除后补拉一次
  });

  it('校验：汇率/点差越界拒绝；拉取失败降级 null（不抛）', async () => {
    const { deps } = setup(ecbFetch(7.2));
    await expect(setFxOverride(deps, { ctx: adminCtx(), rate: '0' })).rejects.toMatchObject({
      code: 'control_plane.invalid_fx_rate',
    });
    await expect(setFxOverride(deps, { ctx: adminCtx(), rate: '9999' })).rejects.toMatchObject({
      code: 'control_plane.invalid_fx_rate',
    });
    await expect(setFxBuffer(deps, { ctx: adminCtx(), bufferPct: '60' })).rejects.toMatchObject({
      code: 'control_plane.invalid_fx_buffer',
    });

    const broken = setup(ecbFetch('fail'));
    const s = await fxState(broken.deps);
    expect(s.baseRate).toBeNull();
    expect(s.effectiveRate).toBeNull();
  });

  it('拉取非 2xx → fx_fetch_failed（unavailable）；审计动作齐备', async () => {
    const { deps, audit } = setup(ecbFetch('fail'));
    await expect(refreshFx(deps, { ctx: adminCtx(), force: true })).rejects.toMatchObject({
      code: 'control_plane.fx_fetch_failed',
    });
    const ok = setup(ecbFetch(7.2));
    await setFxOverride(ok.deps, { ctx: adminCtx(), rate: '7.5' });
    await clearFxOverride(ok.deps, { ctx: adminCtx() });
    await setFxBuffer(ok.deps, { ctx: adminCtx(), bufferPct: '1' });
    expect(ok.audit.entries.map((e) => e.action)).toEqual(
      expect.arrayContaining(['fx.override', 'fx.override_clear', 'fx.buffer']),
    );
    void deps;
    void audit;
  });
});
