/**
 * env → DB 导入（docs/integration-settings/DESIGN.md §7.2、§8）：
 * 计划分组语义（完整导入/半配跳过/全空未配置）、幂等（insert-if-absent 不覆盖）、
 * 落行密文与 enabled、system 审计。
 */
import { describe, expect, it } from 'vitest';

import type { SecretCipher } from '../src/ports/secret-cipher';
import {
  applyIntegrationImport,
  planIntegrationImport,
} from '../src/application/integrations/import-from-env';
import { createMemoryAudit, createMemoryDb, createMemoryIntegrationSettingsStore } from './memory';

const cipher: SecretCipher = {
  encrypt: (plain) => `CIPHER<<${plain}>>`,
  decrypt: (packed) => {
    const match = /^CIPHER<<(.*)>>$/.exec(packed);
    if (match == null) throw new Error('bad ciphertext');
    return match[1] ?? '';
  },
};

const FULL_ENV = {
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_USER: 'ops@example.com',
  SMTP_PASS: 'mail-pass',
  SMTP_FROM: 'no-reply@example.com',
  OAUTH_FRONTEND_URL: 'https://app.example.com',
  OAUTH_API_BASE: 'https://api.example.com',
  OAUTH_GITHUB_CLIENT_ID: 'gh-id',
  OAUTH_GITHUB_CLIENT_SECRET: 'gh-secret',
  CAPTCHA_SITE_KEY: 'site-key',
  CAPTCHA_SECRET_KEY: 'captcha-secret',
  EPAY_PID: '1001',
  EPAY_KEY: 'epay-key',
  EPAY_GATEWAY_URL: 'https://epay.example.com',
  EPAY_NOTIFY_URL: 'https://api.example.com/notify',
  EPAY_RETURN_URL: 'https://app.example.com/return',
  STRIPE_SECRET_KEY: 'sk-live',
  STRIPE_WEBHOOK_SECRET: 'whsec',
  STRIPE_SUCCESS_URL: 'https://app.example.com/ok',
  STRIPE_CANCEL_URL: 'https://app.example.com/no',
};

describe('planIntegrationImport（分组语义）', () => {
  it('完整组 → imports；缺 Google secret → skipped（missing 列出）；全空 → absent', () => {
    const plan = planIntegrationImport({
      ...FULL_ENV,
      OAUTH_GOOGLE_CLIENT_ID: 'google-id-only',
    });
    const keys = plan.imports.map((i) => i.key);
    expect(keys).toContain('smtp');
    expect(keys).toContain('oauth.base');
    expect(keys).toContain('oauth.github');
    expect(keys).toContain('captcha.turnstile');
    expect(keys).toContain('payment.epay');
    expect(keys).toContain('payment.stripe');
    expect(keys).not.toContain('oauth.google');
    expect(plan.skipped).toEqual([
      { key: 'oauth.google', present: ['clientId'], missing: ['clientSecret'] },
    ]);
    expect(plan.absent).toEqual([]);
  });

  it('空 env：全部 absent，无导入无跳过', () => {
    const plan = planIntegrationImport({});
    expect(plan.imports).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.absent).toHaveLength(7);
  });

  it('oauth.base 只有 frontendUrl → 半配跳过（对齐启动期两地址必齐口径）', () => {
    const plan = planIntegrationImport({ OAUTH_FRONTEND_URL: 'https://app.example.com' });
    expect(plan.imports.map((i) => i.key)).toEqual([]);
    expect(plan.skipped[0]?.key).toBe('oauth.base');
    expect(plan.skipped[0]?.missing).toEqual(['apiBase']);
  });

  it('可选字段随组带入（SMTP_PORT/FROM）', () => {
    const plan = planIntegrationImport(FULL_ENV);
    const smtp = plan.imports.find((i) => i.key === 'smtp');
    expect(smtp?.config['port']).toBe('587');
    expect(smtp?.config['from']).toBe('no-reply@example.com');
  });
});

describe('applyIntegrationImport（幂等 + 密文 + 审计）', () => {
  function makeDeps() {
    const memory = createMemoryIntegrationSettingsStore();
    const audit = createMemoryAudit();
    const deps = {
      db: createMemoryDb(),
      stores: { integrationSettings: memory.store },
      cipher,
      audit: audit.sink,
      now: () => new Date('2026-08-25T00:00:00Z'),
    };
    return { deps, memory, audit };
  }

  it('导入完整组：enabled=true、secret 密文、system 审计一条', async () => {
    const { deps, memory, audit } = makeDeps();
    const report = await applyIntegrationImport(deps, planIntegrationImport(FULL_ENV));
    expect(report.imported).toContain('smtp');
    expect(report.skippedExisting).toEqual([]);
    const smtp = memory.rows.get('smtp');
    expect(smtp?.enabled).toBe(true);
    expect(smtp?.config['pass']).toBe('CIPHER<<mail-pass>>');
    expect(smtp?.config['host']).toBe('smtp.example.com');
    const events = audit.entries.filter((e) => e.action === 'settings.integrations.import');
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe('system');
  });

  it('幂等：已有键跳过且不覆盖 admin 已改值', async () => {
    const { deps, memory } = makeDeps();
    await applyIntegrationImport(deps, planIntegrationImport(FULL_ENV));
    memory.rows.set('smtp', {
      key: 'smtp',
      enabled: false,
      config: { host: 'admin-changed.example.com', user: 'u', pass: 'CIPHER<<admin-pass>>' },
      previousSecrets: null,
      rotatedAt: null,
      updatedByAdminId: 9,
      updatedAt: new Date(0),
    });
    const report = await applyIntegrationImport(deps, planIntegrationImport(FULL_ENV));
    expect(report.skippedExisting).toContain('smtp');
    expect(memory.rows.get('smtp')?.config['host']).toBe('admin-changed.example.com');
    expect(memory.rows.get('smtp')?.enabled).toBe(false);
  });
});
