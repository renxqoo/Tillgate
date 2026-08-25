/**
 * 快照解析与 reader（docs/integration-settings/DESIGN.md §5 D4/D6、§8）：
 * effective 语义（OAuth 需 base、支付停用不停验签）、缺省归一、双读窗密钥序列、
 * TTL 缓存/单飞/失效/fail-loud。
 */
import { describe, expect, it } from 'vitest';

import {
  INTEGRATION_CACHE_TTL_MS,
  PAYMENT_SECRET_ROTATION_WINDOW_MS,
} from '../src/domain/integrations/keys';
import type { IntegrationKey } from '../src/domain/integrations/keys';
import type { SecretCipher } from '../src/ports/secret-cipher';
import type { IntegrationSettingsRow } from '../src/ports/integration-settings-store';
import { resolveIntegrationSnapshot } from '../src/application/integrations/resolve-snapshot';
import { createIntegrationSettingsReader } from '../src/application/integrations/create-reader';
import { createMemoryDb, createMemoryIntegrationSettingsStore } from './memory';

/** 微任务/定时器沉降等待（后台刷新落地） */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 5);
  });

const cipher: SecretCipher = {
  encrypt: (plain) => `CIPHER<<${plain}>>`,
  decrypt: (packed) => {
    const match = /^CIPHER<<(.*)>>$/.exec(packed);
    if (match == null) throw new Error('bad ciphertext');
    return match[1] ?? '';
  },
};

function row(
  key: IntegrationKey,
  overrides: Partial<IntegrationSettingsRow> = {},
): IntegrationSettingsRow {
  return {
    key,
    enabled: true,
    config: {},
    previousSecrets: null,
    rotatedAt: null,
    updatedByAdminId: null,
    updatedAt: new Date(0),
    ...overrides,
  };
}

const GH_FULL = {
  clientId: 'gh-id',
  clientSecret: 'CIPHER<<gh-secret>>',
};

function snapshotOf(rows: readonly IntegrationSettingsRow[], nowMs = 0) {
  return resolveIntegrationSnapshot({ cipher, rows, nowMs });
}

describe('快照 effective 语义', () => {
  it('OAuth provider：凭据齐且启用 → effective 且 config 已解密（ADR-0012：base 有效性由装配期 env 保证）', () => {
    const snap = snapshotOf([row('oauth.github', { config: GH_FULL })]);
    expect(snap.oauth.github.configured).toBe(true);
    expect(snap.oauth.github.enabled).toBe(true);
    expect(snap.oauth.github.effective).toBe(true);
    expect(snap.oauth.github.config).toEqual({ clientId: 'gh-id', clientSecret: 'gh-secret' });
  });

  it('SMTP：port/from 缺省归一（465 / 回落 user）', () => {
    const snap = snapshotOf([
      row('smtp', {
        config: { host: 'smtp.example.com', user: 'ops@example.com', pass: 'CIPHER<<p>>' },
      }),
    ]);
    expect(snap.smtp.config).toEqual({
      host: 'smtp.example.com',
      port: 465,
      user: 'ops@example.com',
      pass: 'p',
      from: 'ops@example.com',
    });
  });

  it('支付停用不停验签：enabled=false 但 complete → config 保留（回调面），effective false（下单面）', () => {
    const snap = snapshotOf([
      row('payment.epay', {
        enabled: false,
        config: {
          pid: '1001',
          key: 'CIPHER<<epay-key>>',
          gatewayUrl: 'https://epay.example.com',
          notifyUrl: 'https://api.example.com/notify',
          returnUrl: 'https://app.example.com/return',
        },
      }),
    ]);
    expect(snap.payments.epay.configured).toBe(true);
    expect(snap.payments.epay.enabled).toBe(false);
    expect(snap.payments.epay.effective).toBe(false);
    expect(snap.payments.epay.config?.key).toBe('epay-key');
    expect(snap.payments.epay.config?.payType).toBe('alipay');
  });

  it('secret 解密失败：单行 fail-safe（config null、effective false）', () => {
    const snap = snapshotOf([
      row('smtp', { config: { host: 'h', user: 'u', pass: 'CORRUPT<<x>>' } }),
    ]);
    expect(snap.smtp.config).toBeNull();
    expect(snap.smtp.effective).toBe(false);
    expect(snap.smtp.configured).toBe(true);
  });
});

describe('双读窗密钥序列（DESIGN §5 D6）', () => {
  const rotatedAt = new Date('2026-08-25T00:00:00Z');
  const NOW = rotatedAt.getTime() + 1000;
  const stripeRow = (
    enabled: boolean,
    secrets: Record<string, string> | null,
  ): IntegrationSettingsRow =>
    row('payment.stripe', {
      enabled,
      rotatedAt,
      previousSecrets: secrets,
      config: {
        secretKey: 'CIPHER<<sk>>',
        webhookSecret: 'CIPHER<<whsec_new>>',
        successUrl: 'https://app.example.com/ok',
        cancelUrl: 'https://app.example.com/no',
      },
    });

  it('窗口内：[新, 旧]；无轮换记录：[当前]', () => {
    const snap = snapshotOf([stripeRow(true, { webhookSecret: 'CIPHER<<whsec_old>>' })], NOW);
    expect(snap.payments.stripe.config?.webhookSecrets).toEqual(['whsec_new', 'whsec_old']);
    const noRotation = snapshotOf([stripeRow(true, null)], NOW);
    expect(noRotation.payments.stripe.config?.webhookSecrets).toEqual(['whsec_new']);
  });

  it('窗口外（96h+）：旧密钥退出序列——到期自愈', () => {
    const snap = snapshotOf(
      [stripeRow(true, { webhookSecret: 'CIPHER<<whsec_old>>' })],
      NOW + PAYMENT_SECRET_ROTATION_WINDOW_MS + 1,
    );
    expect(snap.payments.stripe.config?.webhookSecrets).toEqual(['whsec_new']);
  });

  it('窗口常量 = 96h（Stripe 重试期 3 天 + 余量）', () => {
    expect(PAYMENT_SECRET_ROTATION_WINDOW_MS).toBe(96 * 60 * 60 * 1000);
    expect(INTEGRATION_CACHE_TTL_MS).toBe(60_000);
  });
});

describe('reader（TTL 缓存 + 单飞 + 失效 + fail-loud）', () => {
  function makeReader() {
    const memory = createMemoryIntegrationSettingsStore([row('oauth.github', { config: GH_FULL })]);
    let reads = 0;
    let failNext = false;
    const store = {
      async readAll(db: Parameters<typeof memory.store.readAll>[0]) {
        if (failNext) {
          failNext = false;
          throw new Error('db down');
        }
        reads += 1;
        return memory.store.readAll(db);
      },
      upsert: memory.store.upsert.bind(memory.store),
      insertIfAbsent: memory.store.insertIfAbsent.bind(memory.store),
    };
    let nowMs = 0;
    const reader = createIntegrationSettingsReader({
      db: createMemoryDb(),
      stores: { integrationSettings: store },
      cipher,
      now: () => nowMs,
    });
    return {
      reader,
      reads: () => reads,
      failOnce: () => {
        failNext = true;
      },
      advance: (ms: number) => {
        nowMs += ms;
      },
    };
  }

  it('TTL 内命中缓存（只读一次）；过期后重读；invalidate 立即重读', async () => {
    const { reader, reads, advance } = makeReader();
    await reader.resolve();
    await reader.resolve();
    expect(reads()).toBe(1);
    advance(INTEGRATION_CACHE_TTL_MS);
    await reader.resolve();
    expect(reads()).toBe(2);
    reader.invalidate();
    await reader.resolve();
    expect(reads()).toBe(3);
  });

  it('读失败 fail-loud（不静默降级旧快照），下次调用重试成功', async () => {
    const { reader, reads, failOnce } = makeReader();
    await reader.resolve();
    reader.invalidate();
    failOnce();
    await expect(reader.resolve()).rejects.toThrow('db down');
    await reader.resolve();
    expect(reads()).toBe(2);
  });

  it('latest()：从未加载 = 全关快照（不抛）', () => {
    const { reader } = makeReader();
    const initial = reader.latest();
    expect(initial.oauth.github.effective).toBe(false);
    expect(initial.smtp.config).toBeNull();
  });

  it('latest()：TTL 内命中缓存；过期同步返回旧值并后台刷新（失败被吞），严格读仍 fail-loud', async () => {
    const { reader, reads, failOnce, advance } = makeReader();
    await reader.resolve();
    expect(reads()).toBe(1);
    // TTL 内 latest 命中缓存
    expect(reader.latest().oauth.github.effective).toBe(true);
    expect(reads()).toBe(1);
    // 过期后 latest 同步返回旧值并触发后台刷新（失败被吞——makeReader 无 onError 出口）
    advance(INTEGRATION_CACHE_TTL_MS);
    failOnce();
    const stale = reader.latest();
    expect(stale.oauth.github.effective).toBe(true);
    await settle();
    expect(reads()).toBe(1); // 后台刷新失败：计数未增（throw 在计数前）
    await reader.resolve();
    expect(reads()).toBe(2);
  });

  it('latest() 后台刷新失败经 onError 出口', async () => {
    const errors: unknown[] = [];
    const memory = createMemoryIntegrationSettingsStore([row('oauth.github', { config: GH_FULL })]);
    let reads = 0;
    let failNext = false;
    const store = {
      async readAll(db: Parameters<typeof memory.store.readAll>[0]) {
        if (failNext) {
          failNext = false;
          throw new Error('db down');
        }
        reads += 1;
        return memory.store.readAll(db);
      },
      upsert: memory.store.upsert.bind(memory.store),
      insertIfAbsent: memory.store.insertIfAbsent.bind(memory.store),
    };
    let nowMs = 0;
    const reader = createIntegrationSettingsReader({
      db: createMemoryDb(),
      stores: { integrationSettings: store },
      cipher,
      now: () => nowMs,
      onError: (error) => errors.push(error),
    });
    await reader.resolve();
    nowMs += INTEGRATION_CACHE_TTL_MS;
    failNext = true;
    reader.latest();
    await settle();
    expect(errors).toHaveLength(1);
    expect(reads).toBe(1); // 失败读不计数；快照保持旧值
  });
});

describe('review 修复规格：invalidate 竞态与观测出口', () => {
  it('invalidate 后 resolve() 不得复用写前发起的读；旧读完成不得滞留缓存', async () => {
    const gated = createGatedStore([row('oauth.github', { config: GH_FULL })]);
    let nowMs = 0;
    const reader = createIntegrationSettingsReader({
      db: createMemoryDb(),
      stores: { integrationSettings: gated.store },
      cipher,
      now: () => nowMs,
    });
    // t0：首个严格读挂起（快照固定为 enabled=true）
    const first = reader.resolve();
    // 写路径提交 + 用例完成即失效（DESIGN §5 D4 机制）
    await gated.memory.store.upsert(createMemoryDb(), {
      key: 'oauth.github',
      enabled: false,
      config: GH_FULL,
      previousSecrets: null,
      rotatedAt: null,
      adminId: 1,
    });
    reader.invalidate();
    // 写后读：期望新值
    const second = reader.resolve();
    gated.flush();
    await first;
    const afterWrite = await second;
    expect(afterWrite.oauth.github.enabled).toBe(false);
    // 旧读完成不得把 cachedAt 刷成完成时刻 → TTL 内第三次读仍应命中新快照
    nowMs += 1_000;
    const third = await reader.resolve();
    expect(third.oauth.github.enabled).toBe(false);
  });

  it('解密失败的存量密文经 onError 观测出口上报（不再静默 degrade）', async () => {
    const errors: string[] = [];
    const memory = createMemoryIntegrationSettingsStore([
      row('smtp', {
        config: {
          host: 'smtp.example.com',
          user: 'ops',
          pass: 'CORRUPT<<not-decryptable>>',
        },
      }),
    ]);
    const reader = createIntegrationSettingsReader({
      db: createMemoryDb(),
      stores: { integrationSettings: memory.store },
      cipher,
      onError: (error) => errors.push(String(error)),
    });
    const snap = await reader.resolve();
    expect(snap.smtp.config).toBeNull(); // 单行 fail-safe 保持
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('smtp.pass');
  });

  it('refresh() 强制绕过 TTL 重读（支付回调路由预刷缓存用——DESIGN D9 修订）', async () => {
    const memory = createMemoryIntegrationSettingsStore([row('oauth.github', { config: GH_FULL })]);
    let reads = 0;
    const store = {
      async readAll(db: Parameters<typeof memory.store.readAll>[0]) {
        reads += 1;
        return memory.store.readAll(db);
      },
      upsert: memory.store.upsert.bind(memory.store),
      insertIfAbsent: memory.store.insertIfAbsent.bind(memory.store),
    };
    const reader = createIntegrationSettingsReader({
      db: createMemoryDb(),
      stores: { integrationSettings: store },
      cipher,
    });
    await reader.resolve();
    expect(reads).toBe(1);
    // TTL 未到但强制刷新：必须重读
    const forced = await reader.refresh();
    expect(reads).toBe(2);
    expect(forced.oauth.github.effective).toBe(true);
    // refresh 后 latest() 立即拿到新数据（写侧 upsert + refresh 的盲窗消除）
    await memory.store.upsert(createMemoryDb(), {
      key: 'oauth.github',
      enabled: false,
      config: GH_FULL,
      previousSecrets: null,
      rotatedAt: null,
      adminId: null,
    });
    await reader.refresh();
    expect(reader.latest().oauth.github.enabled).toBe(false);
  });
});

/** 门闸 store：读挂起，flush 后按发起时刻快照完成 */
function createGatedStore(seed: IntegrationSettingsRow[]) {
  const memory = createMemoryIntegrationSettingsStore(seed);
  const pending: Array<{
    rows: IntegrationSettingsRow[];
    release: (rows: IntegrationSettingsRow[]) => void;
  }> = [];
  const store = {
    readAll(): Promise<IntegrationSettingsRow[]> {
      const rows = [...memory.rows.values()].map((r) => ({ ...r, config: { ...r.config } }));
      let release!: (rows: IntegrationSettingsRow[]) => void;
      pending.push({ rows, release: (value) => release(value) });
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    upsert: memory.store.upsert.bind(memory.store),
    insertIfAbsent: memory.store.insertIfAbsent.bind(memory.store),
  };
  return { store, memory, flush: () => pending.splice(0).forEach((p) => p.release(p.rows)) };
}
