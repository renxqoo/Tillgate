/**
 * 集成设置域与写用例（docs/integration-settings/DESIGN.md §8）：
 * 词表封闭（↔ 迁移 CHECK）、完整性矩阵、掩码、字段三态合并、轮换入窗、
 * enabled⇒完整性不变量、enc: 伪装拒绝、同事务审计（含回滚与 Turnstile 标志）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { INTEGRATION_KEYS } from '../src/domain/integrations/keys';
import { isValidFieldValue, specOf } from '../src/domain/integrations/specs';
import { maskSecret } from '../src/domain/integrations/masking';
import { isConfigComplete } from '../src/domain/integrations/completeness';
import type { SecretCipher } from '../src/ports/secret-cipher';
import { updateIntegration } from '../src/application/integrations/update-integration';
import {
  adminCtx,
  createMemoryAudit,
  createMemoryDb,
  createMemoryIntegrationSettingsStore,
  rollbackDb,
} from './memory';

/** 结构兼容 runtime.createCipher 的假加密器（前缀避开 enc: 伪装拒绝口径） */
const cipher: SecretCipher = {
  encrypt: (plain) => `CIPHER<<${plain}>>`,
  decrypt: (packed) => {
    const match = /^CIPHER<<(.*)>>$/.exec(packed);
    if (match == null) throw new Error('bad ciphertext');
    return match[1] ?? '';
  },
};

function makeDeps(overrides: Partial<Parameters<typeof updateIntegration>[0]> = {}) {
  const memory = createMemoryIntegrationSettingsStore();
  const audit = createMemoryAudit();
  const deps = {
    db: createMemoryDb(),
    stores: { integrationSettings: memory.store },
    cipher,
    audit: audit.sink,
    auditTx: audit.txSink,
    now: () => new Date('2026-08-25T00:00:00Z'),
    ...overrides,
  };
  return { deps, memory, audit };
}

describe('词表封闭', () => {
  it('INTEGRATION_KEYS 与迁移 0086 的 DB CHECK 逐项相等', () => {
    const sql = readFileSync(
      join(import.meta.dirname, '../../db/migrations/0086_integration_settings.sql'),
      'utf8',
    );
    const check = /CHECK \(key IN \(([^)]+)\)/.exec(sql);
    expect(check).not.toBeNull();
    const sqlKeys = (check?.[1] ?? '')
      .split(',')
      .map((part) => part.trim().replace(/'/g, ''))
      .filter((part) => part.length > 0);
    expect([...INTEGRATION_KEYS].toSorted()).toEqual([...sqlKeys].toSorted());
  });

  it('每 key 规格字段名唯一且至少一必填', () => {
    for (const key of INTEGRATION_KEYS) {
      const names = specOf(key).fields.map((f) => f.name);
      expect(new Set(names).size, key).toBe(names.length);
      expect(names.length, key).toBeGreaterThan(0);
      expect(
        specOf(key).fields.some((f) => f.required),
        key,
      ).toBe(true);
    }
  });

  it('rotatable 字段仅存在于支付验签字段（epay.key / stripe.webhookSecret）', () => {
    const rotatable: string[] = [];
    for (const key of INTEGRATION_KEYS) {
      for (const field of specOf(key).fields) {
        if (field.rotatable) rotatable.push(`${key}.${field.name}`);
      }
    }
    expect(rotatable).toEqual(['payment.epay.key', 'payment.stripe.webhookSecret']);
  });
});

describe('完整性与字段校验（表驱动）', () => {
  const cases = INTEGRATION_KEYS.map((key) => {
    const requiredNames = specOf(key)
      .fields.filter((f) => f.required)
      .map((f) => f.name);
    const first = requiredNames[0] ?? '';
    return {
      key,
      empty: {},
      half: { [first]: 'x' },
      full: Object.fromEntries(
        requiredNames.map((name) => [name, 'x'.repeat(name === 'port' ? 4 : 12)]),
      ),
    };
  });

  it('configured = 必填全非空（空/半配 false，全配 true——逐 key 遍历）', () => {
    for (const c of cases) {
      const spec = specOf(c.key);
      expect(isConfigComplete(spec, c.empty), `${c.key} empty`).toBe(false);
      expect(isConfigComplete(spec, c.half), `${c.key} half`).toBe(false);
      expect(isConfigComplete(spec, c.full), `${c.key} full`).toBe(true);
    }
  });

  it('字段形状校验矩阵', () => {
    expect(isValidFieldValue('text', 'any-nonempty')).toBe(true);
    expect(isValidFieldValue('text', '')).toBe(false);
    expect(isValidFieldValue('url', 'https://api.github.com')).toBe(true);
    expect(isValidFieldValue('url', 'ftp://x')).toBe(false);
    expect(isValidFieldValue('url', 'not-a-url')).toBe(false);
    expect(isValidFieldValue('port', '465')).toBe(true);
    expect(isValidFieldValue('port', '0')).toBe(false);
    expect(isValidFieldValue('port', '65536')).toBe(false);
    expect(isValidFieldValue('port', 'abc')).toBe(false);
    expect(isValidFieldValue('payType', 'alipay')).toBe(true);
    expect(isValidFieldValue('payType', 'paypal')).toBe(false);
    expect(isValidFieldValue('text', 'x'.repeat(1025))).toBe(false);
  });
});

describe('掩码', () => {
  it('长值留尾 4，短值全遮', () => {
    expect(maskSecret('abcdefghijklmnop')).toBe('****mnop');
    expect(maskSecret('short')).toBe('****');
  });
});

describe('updateIntegration（字段三态 + 不变量 + 轮换 + 审计）', () => {
  const SMTP_FULL = {
    host: 'smtp.example.com',
    port: '465',
    user: 'ops@example.com',
    pass: 'secret-pass-9',
    from: 'no-reply@example.com',
  };

  it('设置全字段：secret 密文落库、回显掩码、configured/enabled 生效', async () => {
    const { deps, memory } = makeDeps();
    const item = await updateIntegration(deps, {
      ctx: adminCtx(),
      key: 'smtp',
      enabled: true,
      config: SMTP_FULL,
    });
    expect(item.config['host']).toBe('smtp.example.com');
    // 掩码形态：**** + 尾 4
    expect(item.config['pass']).toBe(`****${SMTP_FULL.pass.slice(-4)}`);
    expect(item.configured).toBe(true);
    expect(item.enabled).toBe(true);
    expect(item.secretsSet).toEqual(['pass']);
    const row = memory.rows.get('smtp');
    expect(row?.config['pass']).toBe(`CIPHER<<${SMTP_FULL.pass}>>`);
    expect(row?.config['host']).toBe('smtp.example.com');
  });

  it('write-only：缺席字段保持现值；非 secret 字段可单独改', async () => {
    const { deps, memory } = makeDeps();
    await updateIntegration(deps, {
      ctx: adminCtx(),
      key: 'smtp',
      enabled: true,
      config: SMTP_FULL,
    });
    await updateIntegration(deps, {
      ctx: adminCtx(),
      key: 'smtp',
      config: { host: 'smtp2.example.com' },
    });
    const row = memory.rows.get('smtp');
    expect(row?.config['host']).toBe('smtp2.example.com');
    expect(row?.config['pass']).toBe(`CIPHER<<${SMTP_FULL.pass}>>`);
    expect(row?.enabled).toBe(true);
  });

  it('null = 清除字段：清除必填 secret 后 enabled 仍 true 被拒（不变量）', async () => {
    const { deps } = makeDeps();
    await updateIntegration(deps, {
      ctx: adminCtx(),
      key: 'smtp',
      enabled: true,
      config: SMTP_FULL,
    });
    // 先停用再清除 = 合法路径
    await updateIntegration(deps, {
      ctx: adminCtx(),
      key: 'smtp',
      enabled: false,
      config: { pass: null },
    });
    const { listIntegrations } = await import('../src/application/integrations/list-integrations');
    const view = await listIntegrations(deps);
    const smtp = view.integrations.find((i) => i.key === 'smtp');
    expect(smtp?.enabled).toBe(false);
    expect(smtp?.config['pass']).toBeNull();
    expect(smtp?.config['host']).toBe('smtp.example.com');
    // 半配 + enabled=true 直接拒绝
    await expect(
      updateIntegration(deps, { ctx: adminCtx(), key: 'smtp', enabled: true }),
    ).rejects.toMatchObject({ code: 'control_plane.integration_config_incomplete' });
  });

  it('enc: 伪装密文拒绝；未知字段拒绝；坏形状拒绝；未知 key 404', async () => {
    const { deps } = makeDeps();
    await expect(
      updateIntegration(deps, {
        ctx: adminCtx(),
        key: 'smtp',
        config: { pass: 'enc:v1:iv:tag:body' },
      }),
    ).rejects.toMatchObject({ code: 'control_plane.integration_secret_encrypted' });
    await expect(
      updateIntegration(deps, { ctx: adminCtx(), key: 'smtp', config: { unknownField: 'x' } }),
    ).rejects.toMatchObject({ code: 'control_plane.integration_field_invalid' });
    await expect(
      updateIntegration(deps, {
        ctx: adminCtx(),
        key: 'oauth.base',
        config: { frontendUrl: 'not-a-url' },
      }),
    ).rejects.toMatchObject({ code: 'control_plane.integration_field_invalid' });
    await expect(
      updateIntegration(deps, {
        ctx: adminCtx(),
        key: 'payment.epay',
        config: { payType: 'paypal' },
      }),
    ).rejects.toMatchObject({ code: 'control_plane.integration_field_invalid' });
    await expect(
      updateIntegration(deps, { ctx: adminCtx(), key: 'payment.paypal', config: {} }),
    ).rejects.toMatchObject({ code: 'control_plane.integration_unknown' });
  });

  it('轮换入窗：rotatable secret 变更 → 旧密文进 previous_secrets 并刷新 rotatedAt', async () => {
    const { deps, memory } = makeDeps();
    await updateIntegration(deps, {
      ctx: adminCtx(),
      key: 'payment.stripe',
      enabled: true,
      config: {
        secretKey: 'sk-live-aaaa',
        webhookSecret: 'whsec_old_1',
        successUrl: 'https://app.example.com/ok',
        cancelUrl: 'https://app.example.com/cancel',
      },
    });
    await updateIntegration(deps, {
      ctx: adminCtx(),
      key: 'payment.stripe',
      config: { webhookSecret: 'whsec_new_2' },
    });
    const row = memory.rows.get('payment.stripe');
    expect(row?.config['webhookSecret']).toBe('CIPHER<<whsec_new_2>>');
    expect(row?.previousSecrets?.['webhookSecret']).toBe('CIPHER<<whsec_old_1>>');
    expect(row?.rotatedAt?.toISOString()).toBe('2026-08-25T00:00:00.000Z');
  });

  it('审计：action/target/detail 与 Turnstile 停用标志', async () => {
    const { deps, audit } = makeDeps();
    await updateIntegration(deps, {
      ctx: adminCtx(7),
      key: 'captcha.turnstile',
      enabled: true,
      config: { siteKey: 'site-key-abcdef', secretKey: 'secret-key-000111' },
    });
    await updateIntegration(deps, { ctx: adminCtx(7), key: 'captcha.turnstile', enabled: false });
    const events = audit.entries.filter((e) => e.action === 'settings.integrations.update');
    expect(events).toHaveLength(2);
    expect(events[0]?.targetId).toBe('captcha.turnstile');
    expect(events[0]?.detail).toMatchObject({ enabledFrom: false, enabledTo: true });
    expect(events[0]?.detail).not.toHaveProperty('securityControlDisabled');
    expect(events[1]?.detail).toMatchObject({
      enabledFrom: true,
      enabledTo: false,
      securityControlDisabled: true,
    });
  });

  it('同事务：审计写失败 → 业务回滚（§5.4）', async () => {
    const memory = createMemoryIntegrationSettingsStore();
    const audit = createMemoryAudit();
    const deps = {
      db: rollbackDb(memory.snapshot),
      stores: { integrationSettings: memory.store },
      cipher,
      audit: audit.sink,
      auditTx: audit.txSink,
      now: () => new Date('2026-08-25T00:00:00Z'),
    };
    audit.fail.on = true;
    await expect(
      updateIntegration(deps, { ctx: adminCtx(), key: 'smtp', enabled: true, config: SMTP_FULL }),
    ).rejects.toThrow('audit sink down');
    expect(memory.rows.get('smtp')).toBeUndefined();
  });
});
