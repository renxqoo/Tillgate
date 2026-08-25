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
import { resolveIntegrationSnapshot } from '../src/application/integrations/resolve-snapshot';
import type { IntegrationSettingsRow } from '../src/ports/integration-settings-store';
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
  it('INTEGRATION_KEYS 与迁移 0088（现行 CHECK，ADR-0012）逐项相等', () => {
    const sql = readFileSync(
      join(import.meta.dirname, '../../db/migrations/0088_oauth_base_to_env.sql'),
      'utf8',
    );
    const check = /CHECK \("key" IN \(([^)]+)\)/.exec(sql);
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
        key: 'oauth.github',
        config: { clientId: '' },
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

// ── review 修复规格（红测移植：A-1/A-3/R3/R4/R5/M8/H1 形状守卫）────────────────────

/** 已轮换的 stripe 行（t0 起窗）——窗口保留规格共用装置 */
function rotatedStripeRow(): IntegrationSettingsRow {
  return {
    key: 'payment.stripe',
    enabled: true,
    config: {
      secretKey: 'CIPHER<<sk-live-aaaa>>',
      webhookSecret: 'CIPHER<<whsec_new>>',
      successUrl: 'https://app.example.com/ok',
      cancelUrl: 'https://app.example.com/no',
    },
    previousSecrets: { webhookSecret: 'CIPHER<<whsec_old>>' },
    rotatedAt: new Date('2026-08-25T00:00:00Z'),
    updatedByAdminId: 1,
    updatedAt: new Date('2026-08-25T00:00:00Z'),
  };
}

/** 双前缀 cipher 装置：构造互不解密的两把 key（换 key 场景） */
function prefixCipher(prefix: string): SecretCipher {
  return {
    encrypt: (plain) => `${prefix}<<${plain}>>`,
    decrypt: (packed) => {
      const match = new RegExp(`^${prefix}<<(.*)>>$`).exec(packed);
      if (match == null) throw new Error('bad ciphertext');
      return match[1] ?? '';
    },
  };
}

/** 窗口应保留的期望：previous_secrets 旧密文仍在、rotatedAt 不回退 */
function expectWindowKept(memory: ReturnType<typeof createMemoryIntegrationSettingsStore>): void {
  const row = memory.rows.get('payment.stripe');
  expect(row?.previousSecrets?.['webhookSecret']).toBe('CIPHER<<whsec_old>>');
  expect(row?.rotatedAt?.toISOString()).toBe('2026-08-25T00:00:00.000Z');
}

describe('review 修复规格：双读窗保留（DESIGN §5 D6 退出条件=时间到期）', () => {
  const windowDeps = (seed: IntegrationSettingsRow[], nowValue: Date) => {
    const memory = createMemoryIntegrationSettingsStore(seed);
    const audit = createMemoryAudit();
    const now = { value: nowValue };
    return {
      memory,
      deps: {
        db: createMemoryDb(),
        stores: { integrationSettings: memory.store },
        cipher,
        audit: audit.sink,
        auditTx: audit.txSink,
        now: () => now.value,
      } as Parameters<typeof updateIntegration>[0],
      advance: (next: Date) => {
        now.value = next;
      },
    };
  };

  it('场景 A：轮换后仅改非 rotatable 字段（successUrl）→ 窗口保留', async () => {
    const { deps, memory } = windowDeps([rotatedStripeRow()], new Date('2026-08-25T02:00:00Z'));
    await updateIntegration(deps, {
      ctx: adminCtx(),
      key: 'payment.stripe',
      config: { successUrl: 'https://app.example.com/ok2' },
    });
    expectWindowKept(memory);
  });

  it('场景 B：轮换后停用渠道 → 窗口保留（停用不停验签——验签序列仍 [新, 旧]）', async () => {
    const { deps, memory } = windowDeps([rotatedStripeRow()], new Date('2026-08-25T02:00:00Z'));
    await updateIntegration(deps, { ctx: adminCtx(), key: 'payment.stripe', enabled: false });
    expectWindowKept(memory);
    const snap = resolveIntegrationSnapshot({
      cipher,
      rows: [...memory.rows.values()],
      nowMs: new Date('2026-08-25T02:00:00Z').getTime(),
    });
    expect(snap.payments.stripe.config?.webhookSecrets).toEqual(['whsec_new', 'whsec_old']);
  });

  it('场景 C：提交与现值相同的 rotatable 值（no-op）→ 窗口保留', async () => {
    const { deps, memory } = windowDeps([rotatedStripeRow()], new Date('2026-08-25T02:00:00Z'));
    await updateIntegration(deps, {
      ctx: adminCtx(),
      key: 'payment.stripe',
      config: { webhookSecret: 'whsec_new' },
    });
    expectWindowKept(memory);
  });

  it('窗口到期后的下一次写入清窗（存储自愈——M9）', async () => {
    const { deps, memory } = windowDeps(
      [rotatedStripeRow()],
      new Date('2026-08-29T01:00:00Z'), // t0+97h：窗口已过期
    );
    await updateIntegration(deps, {
      ctx: adminCtx(),
      key: 'payment.stripe',
      config: { successUrl: 'https://app.example.com/ok3' },
    });
    expect(memory.rows.get('payment.stripe')?.previousSecrets).toBeNull();
    expect(memory.rows.get('payment.stripe')?.rotatedAt).toBeNull();
  });
});

describe('review 修复规格：解密失败的存量密文不得二次加密、不得回显密文片段', () => {
  const legacyRow = (): IntegrationSettingsRow => ({
    key: 'smtp',
    enabled: true,
    config: {
      host: 'smtp.example.com',
      port: '465',
      user: 'ops@example.com',
      pass: prefixCipher('OLD').encrypt('secret-pass-9'),
      from: 'no-reply@example.com',
    },
    previousSecrets: null,
    rotatedAt: null,
    updatedByAdminId: null,
    updatedAt: new Date(0),
  });

  const legacyDeps = (seed: IntegrationSettingsRow[]) => {
    const memory = createMemoryIntegrationSettingsStore(seed);
    const audit = createMemoryAudit();
    return {
      memory,
      deps: {
        db: createMemoryDb(),
        stores: { integrationSettings: memory.store },
        cipher: prefixCipher('NEW'),
        audit: audit.sink,
        auditTx: audit.txSink,
        now: () => new Date('2026-08-25T00:00:00Z'),
      } as Parameters<typeof updateIntegration>[0],
    };
  };

  it('更新非 secret 字段：旧 key 密文原样保留（换回旧 key 可恢复），不被二次包装', async () => {
    const { deps, memory } = legacyDeps([legacyRow()]);
    await updateIntegration(deps, {
      ctx: adminCtx(),
      key: 'smtp',
      config: { host: 'smtp2.example.com' },
    });
    expect(memory.rows.get('smtp')?.config['pass']).toBe(
      prefixCipher('OLD').encrypt('secret-pass-9'),
    );
  });

  it('PUT 响应对不可解密字段回显 ****；快照面整行 fail-safe 不被击穿', async () => {
    const { deps, memory } = legacyDeps([legacyRow()]);
    const item = await updateIntegration(deps, {
      ctx: adminCtx(),
      key: 'smtp',
      config: { host: 'smtp2.example.com' },
    });
    expect(item.config['pass']).toBe('****');
    const snap = resolveIntegrationSnapshot({
      cipher: prefixCipher('NEW'),
      rows: [...memory.rows.values()],
      nowMs: 0,
    });
    expect(snap.smtp.config).toBeNull();
    expect(snap.smtp.effective).toBe(false);
  });
});

describe('review 修复规格：写入校验加固', () => {
  it('空白串值拒绝（trim 后为空 = 无效值）', async () => {
    const { deps } = makeDeps();
    await expect(
      updateIntegration(deps, { ctx: adminCtx(), key: 'smtp', config: { host: ' ' } }),
    ).rejects.toMatchObject({ code: 'control_plane.integration_field_invalid' });
  });

  it('enc: 伪装密文检查覆盖前导空白与大小写变体', async () => {
    const { deps } = makeDeps();
    for (const value of [' enc:v1:iv:tag:body', 'ENC:v1:iv:tag:body', 'Enc:v1:x']) {
      await expect(
        updateIntegration(deps, { ctx: adminCtx(), key: 'smtp', config: { pass: value } }),
      ).rejects.toMatchObject({ code: 'control_plane.integration_secret_encrypted' });
    }
  });

  it('URL 字段拒绝内网/回环字面量（SSRF 探测面收窄）', () => {
    for (const bad of [
      'http://127.0.0.1:8080/x',
      'http://localhost/x',
      'http://10.1.2.3/x',
      'http://192.168.1.1/x',
      'http://172.16.0.1/x',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/x',
      'http://0.0.0.0/x',
    ]) {
      expect(isValidFieldValue('url', bad), bad).toBe(false);
    }
    for (const good of ['https://api.stripe.com', 'http://203.0.113.10/x']) {
      expect(isValidFieldValue('url', good), good).toBe(true);
    }
  });

  it('smtp.host 形状校验：拒绝 scheme/路径；允许私网中继（合法形态）', () => {
    expect(isValidFieldValue('host', 'smtp.example.com')).toBe(true);
    expect(isValidFieldValue('host', '192.168.1.5')).toBe(true);
    expect(isValidFieldValue('host', 'http://smtp.example.com')).toBe(false);
    expect(isValidFieldValue('host', 'smtp.example.com/path')).toBe(false);
  });

  it('list 的 secretsSet 与掩码口径一致（空串不计入——M8）', async () => {
    const memory = createMemoryIntegrationSettingsStore();
    await memory.store.upsert(createMemoryDb(), {
      key: 'smtp',
      enabled: false,
      config: { host: 'h', user: 'u', pass: '' },
      previousSecrets: null,
      rotatedAt: null,
      adminId: null,
    });
    const { listIntegrations } = await import('../src/application/integrations/list-integrations');
    const view = await listIntegrations({
      db: createMemoryDb(),
      stores: { integrationSettings: memory.store },
      cipher,
    });
    const smtp = view.integrations.find((i) => i.key === 'smtp');
    expect(smtp?.secretsSet).toEqual([]);
    expect(smtp?.config['pass']).toBeNull();
  });

  it('出网点变更（url/host 字段）审计高亮 outboundEndpointChanged', async () => {
    const { deps, audit } = makeDeps();
    await updateIntegration(deps, {
      ctx: adminCtx(),
      key: 'payment.stripe',
      enabled: true,
      config: {
        secretKey: 'sk-live-aaaa',
        webhookSecret: 'whsec-aaaa',
        successUrl: 'https://app.example.com/ok',
        cancelUrl: 'https://app.example.com/no',
      },
    });
    await updateIntegration(deps, {
      ctx: adminCtx(),
      key: 'payment.stripe',
      config: { successUrl: 'https://app.example.com/ok2' },
    });
    const events = audit.entries.filter((e) => e.action === 'settings.integrations.update');
    expect(events[1]?.detail).toMatchObject({ outboundEndpointChanged: true });
    // 非 url 字段变更不标
    await updateIntegration(deps, {
      ctx: adminCtx(),
      key: 'payment.stripe',
      config: { secretKey: 'sk-live-bbbb' },
    });
    const third = audit.entries.filter((e) => e.action === 'settings.integrations.update').at(-1);
    expect(third?.detail).not.toHaveProperty('outboundEndpointChanged');
  });
});
