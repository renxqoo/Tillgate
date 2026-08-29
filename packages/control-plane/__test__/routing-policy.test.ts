/**
 * saveRoutingPolicy 用例：version 自增透传 / 审计快照记实际落库值（note 未传
 * 保留旧值——审计与 DB 行一致）/ store 抛错翻译 routing_policy_save_failed（零审计）。
 * store 的 SQL 专属语义（ON CONFLICT 原子 upsert）由 postgres.real.test.ts 承担。
 */
import { describe, expect, it } from 'vitest';
import type { Db } from '@tillgate/db';
import { saveRoutingPolicy } from '../src/application/routing/save-policy';
import type { SaveRoutingPolicyDeps } from '../src/application/routing/save-policy';
import { adminCtx, createMemoryAudit, createMemoryRoutingPolicyStore } from './memory';

const systemCtx = () => ({
  requestId: `req-sys-${Math.random().toString(36).slice(2, 8)}`,
  actor: { kind: 'system' as const },
});

function makeDeps() {
  const routingPolicy = createMemoryRoutingPolicyStore();
  const audit = createMemoryAudit();
  const deps = {
    db: {} as Db,
    stores: { routingPolicy: routingPolicy.store },
    audit: audit.sink,
  } satisfies SaveRoutingPolicyDeps;
  return { deps, routingPolicy, audit };
}

describe('saveRoutingPolicy', () => {
  it('admin 首存 → version=1、updatedBy=admin:{id}、审计快照与落库行一致', async () => {
    const { deps, routingPolicy, audit } = makeDeps();
    const policy = { scorers: { ttft: 1 } };
    const result = await saveRoutingPolicy(deps, { policy, note: '调权', ctx: adminCtx(7) });

    expect(result.version).toBe('1');
    expect(result.savedAt).toBeInstanceOf(Date);
    expect(routingPolicy.state.row).toMatchObject({
      scope: 'global',
      version: '1',
      policy,
      note: '调权',
      updatedBy: 'admin:7',
    });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      actor: 'admin',
      adminId: 7,
      action: 'routing.policy_update',
      targetType: 'routing_policy',
      targetId: 'global',
      detail: { version: '1', note: '调权', policy, updatedBy: 'admin:7' },
    });
  });

  it('再存 → version 自增透传,审计 detail.version 与返回一致', async () => {
    const { deps, audit } = makeDeps();
    await saveRoutingPolicy(deps, { policy: { a: 1 }, ctx: adminCtx(7) });
    const second = await saveRoutingPolicy(deps, { policy: { a: 2 }, ctx: adminCtx(7) });

    expect(second.version).toBe('2');
    expect(audit.entries.at(-1)?.detail).toMatchObject({ version: '2', policy: { a: 2 } });
  });

  it('note 未传保留旧值,审计记实际落库值而非入参（回滚依据与 DB 行一致）', async () => {
    const { deps, routingPolicy, audit } = makeDeps();
    await saveRoutingPolicy(deps, { policy: { a: 1 }, note: '第一版', ctx: adminCtx(7) });
    const second = await saveRoutingPolicy(deps, { policy: { a: 2 }, ctx: adminCtx(7) });

    expect(second.version).toBe('2');
    expect(routingPolicy.state.row?.note).toBe('第一版');
    // 旧实现记 input.note ?? null → null;契约是审计与落库行一致
    expect(audit.entries.at(-1)?.detail).toMatchObject({ version: '2', note: '第一版' });
  });

  it('system 操作者 → actor=system、adminId=null、不写 updatedBy', async () => {
    const { deps, routingPolicy, audit } = makeDeps();
    await saveRoutingPolicy(deps, { policy: { a: 1 }, ctx: systemCtx() });

    expect(routingPolicy.state.row).toMatchObject({ updatedBy: null });
    expect(audit.entries[0]).toMatchObject({ actor: 'system', adminId: null });
    expect(audit.entries[0]?.detail).not.toHaveProperty('updatedBy');
  });

  it('store 抛错 → routing_policy_save_failed 且零审计（不假成功）', async () => {
    const { deps, routingPolicy, audit } = makeDeps();
    routingPolicy.fail.on = true;

    await expect(
      saveRoutingPolicy(deps, { policy: { a: 1 }, ctx: adminCtx(7) }),
    ).rejects.toMatchObject({ code: 'control_plane.routing_policy_save_failed' });
    expect(audit.entries).toEqual([]);
    expect(routingPolicy.state.row).toBeNull();
  });

  it('audit sink 故障不反噬（best-effort 降级——策略已落库）', async () => {
    const { deps, routingPolicy, audit } = makeDeps();
    audit.fail.on = true;

    await expect(
      saveRoutingPolicy(deps, { policy: { a: 1 }, ctx: adminCtx(7) }),
    ).resolves.toMatchObject({ version: '1' });
    expect(routingPolicy.state.row).not.toBeNull();
  });
});
