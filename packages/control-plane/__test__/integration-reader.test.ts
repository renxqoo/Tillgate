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

const BASE_FULL = {
  frontendUrl: 'https://app.example.com',
  apiBase: 'https://api.example.com',
};

function snapshotOf(rows: readonly IntegrationSettingsRow[], nowMs = 0) {
  return resolveIntegrationSnapshot({ cipher, rows, nowMs });
}

describe('快照 effective 语义', () => {
  it('OAuth provider：自身完整且启用，但 base 缺失 → effective false', () => {
    const snap = snapshotOf([
      row('oauth.github', {
        config: { clientId: 'gh-id', clientSecret: `CIPHER<<gh-secret>>` },
      }),
    ]);
    expect(snap.oauth.github.configured).toBe(true);
    expect(snap.oauth.github.enabled).toBe(true);
    expect(snap.oauth.github.effective).toBe(false);
    // config 只看自身完整性（与 enabled 无关——DESIGN §5 D6 同口径）
    expect(snap.oauth.github.config).toEqual({ clientId: 'gh-id', clientSecret: 'gh-secret' });
    expect(snap.oauth.base.effective).toBe(false);
  });

  it('OAuth provider：base 生效 + 凭据齐 → effective 且 config 已解密', () => {
    const snap = snapshotOf([
      row('oauth.base', { config: BASE_FULL }),
      row('oauth.github', { config: { clientId: 'gh-id', clientSecret: 'CIPHER<<gh-secret>>' } }),
    ]);
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
    expect(PAYMENT_SECRET_ROTATION_WINDOW_MS).toBe(96 * 24 * 60 * 60 * 1000);
    expect(INTEGRATION_CACHE_TTL_MS).toBe(60_000);
  });
});

describe('reader（TTL 缓存 + 单飞 + 失效 + fail-loud）', () => {
  function makeReader() {
    const memory = createMemoryIntegrationSettingsStore([row('oauth.base', { config: BASE_FULL })]);
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
});
