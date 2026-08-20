/**
 * Key 管理集成套件（真 PG）：明文一次出库 / 哈希真相 / 吊销 CAS /
 * 越权不可见。不变量：列表与详情永不携带 keyHash；吊销后网关侧即失效（status=1）。
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@ai-gateway/http';
import { createRepositories } from '@ai-gateway/repository';
import { systemContext } from '@ai-gateway/service';
import { createKeysService } from '../services/keys.service.js';
import { isValidDailySpendLimitInput } from '../domain/key-limits.js';
import { db, newUser } from './helpers.js';

const ctx = systemContext('cav2-keys');
const repos = createRepositories();

function buildService() {
  return createKeysService({ db });
}

describe('Key 生命周期', () => {
  it('创建：明文仅此一次返回；库内哈希可被网关鉴权查表命中', async () => {
    const account = await newUser();
    const service = buildService();
    const created = await service.create(ctx, account.id, { name: 'prod' });
    expect(created.plaintext).toMatch(/^ag_[0-9a-f]{40}$/);
    expect(created.keyPreview).toBe(
      created.plaintext.slice(0, 3) + '****' + created.plaintext.slice(-4),
    );
    expect(created.status).toBe(0);
    // 网关侧真相：SHA-256(明文) 能命中有效 Key（同口径落库）
    const hit = await repos.credential.findActiveKeyByKeyHash(
      { db, requestId: 't', actor: { kind: 'system' }, traceParent: null },
      sha256Hex(created.plaintext),
    );
    expect(hit?.id).toBe(created.id);
    expect(hit?.userId).toBe(account.id);
  });

  it('列表：不含 keyHash 字段；明文/哈希都不出现在响应形状里', async () => {
    const account = await newUser();
    const service = buildService();
    const created = await service.create(ctx, account.id, { name: 'list-me' });
    const list = await service.list(ctx, account.id, { page: 1, limit: 10 });
    expect(list.total).toBe(1);
    const row = list.rows[0]!;
    expect((row as unknown as Record<string, unknown>).keyHash).toBeUndefined();
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain(created.plaintext);
    expect(serialized).not.toContain(sha256Hex(created.plaintext));
  });

  it('吊销：status→1 + revokedAt；重复吊销 409；吊销后列表在用数归零', async () => {
    const account = await newUser();
    const service = buildService();
    const created = await service.create(ctx, account.id, { name: 'to-revoke' });
    await service.revoke(ctx, account.id, created.id);
    await expect(service.revoke(ctx, account.id, created.id)).rejects.toMatchObject({
      code: 'key_already_revoked',
    });
    const list = await service.list(ctx, account.id, { page: 1, limit: 10 });
    expect(list.rows.find((r) => r.id === created.id)?.status).toBe(1);
    expect(list.rows.find((r) => r.id === created.id)?.revokedAt).not.toBeNull();
  });

  it('越权：他人 Key 吊销/查看一律 404（不泄漏存在性）', async () => {
    const owner = await newUser();
    const attacker = await newUser();
    const service = buildService();
    const created = await service.create(ctx, owner.id, { name: 'private' });
    await expect(service.revoke(ctx, attacker.id, created.id)).rejects.toMatchObject({
      status: 404,
    });
    const attackerList = await service.list(ctx, attacker.id, { page: 1, limit: 10 });
    expect(attackerList.total).toBe(0);
  });

  it('限流/限额字段透传落库（rpm/tpm/每日上限/过期时间）', async () => {
    const account = await newUser();
    const service = buildService();
    const expiresAt = new Date(Date.now() + 86_400_000);
    const created = await service.create(ctx, account.id, {
      name: 'limited',
      rpmLimit: 60,
      tpmLimit: 100_000,
      dailySpendLimit: '10.5',
      expiresAt: expiresAt.toISOString(),
    });
    expect(created.rpmLimit).toBe(60);
    expect(created.tpmLimit).toBe(100_000);
    expect(created.dailySpendLimit!.startsWith('10.5')).toBe(true);
    expect(created.expiresAt).not.toBeNull();
  });

  it('PATCH：改名/限额即时生效（网关每请求查库，无缓存窗口）；回显永不含 keyHash', async () => {
    const account = await newUser();
    const service = buildService();
    const created = await service.create(ctx, account.id, { name: 'before' });
    const patched = await service.patch(ctx, account.id, created.id, {
      name: 'after',
      rpmLimit: 120,
      dailySpendLimit: '9.9',
    });
    expect(patched.name).toBe('after');
    expect(patched.rpmLimit).toBe(120);
    expect(patched.dailySpendLimit!.startsWith('9.9')).toBe(true);
    expect((patched as unknown as Record<string, unknown>).keyHash).toBeUndefined();
    const list = await service.list(ctx, account.id, { page: 1, limit: 10 });
    expect(list.rows[0]!.name).toBe('after');
    // 已吊销 Key 不可 PATCH
    await service.revoke(ctx, account.id, created.id);
    await expect(
      service.patch(ctx, account.id, created.id, { name: 'nope' }),
    ).rejects.toMatchObject({ code: 'key_already_revoked' });
  });

  it('RED（v1 keys.numeric-limit 同类）：超大/畸形日限额结构性拒绝，不得落库溢出 500', async () => {
    const badLimits = [
      '1e21',                      // 科学计数法——裸 Decimal 认，numeric(38,18) 爆
      '9999999999999999999999',    // 22 位整数——超尺度
      '-5',                        // 负数
      'NaN',                       // 非数
      '1000000000001',             // 超业务上界（>1e12）
    ];
    for (const dailySpendLimit of badLimits) {
      expect(isValidDailySpendLimitInput(dailySpendLimit), `应拒绝 ${dailySpendLimit}`).toBe(false);
    }
    // 对照：合法值通过
    expect(isValidDailySpendLimitInput('10.5')).toBe(true);
    expect(isValidDailySpendLimitInput('0.000000000000000001')).toBe(true);
  });
});
