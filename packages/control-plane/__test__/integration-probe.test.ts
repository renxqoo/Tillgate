/**
 * SMTP 集成连通性探针用例：
 * 三态合并口径（存量+弹窗提交值）、目标归一（port/from 缺省）、完整性前置、
 * 坏密文显式诊断、上游失败/适配器异常折叠为探针结果。
 */
import { describe, expect, it } from 'vitest';

import { probeSmtp } from '../src/application/integrations/probe-smtp';
import type { ProbeSmtpDeps } from '../src/application/integrations/probe-smtp';
import type { IntegrationSettingsRow } from '../src/ports/integration-settings-store';
import type { SecretCipher } from '../src/ports/secret-cipher';
import {
  createMemoryDb,
  createMemoryIntegrationSettingsStore,
  createStubSmtpProbe,
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

/** 已配置存量行（pass 密文；port/from 缺省——探针归一口径的用例基础） */
function smtpRow(config: Record<string, unknown>): IntegrationSettingsRow {
  return {
    key: 'smtp',
    enabled: true,
    config,
    previousSecrets: null,
    rotatedAt: null,
    updatedByAdminId: 1,
    updatedAt: new Date('2026-08-25T00:00:00Z'),
  };
}

function setup(
  seed: IntegrationSettingsRow[] = [],
  override?: Parameters<typeof createStubSmtpProbe>[0],
) {
  const memory = createMemoryIntegrationSettingsStore(seed);
  const stub = createStubSmtpProbe(override);
  const deps: ProbeSmtpDeps = {
    db: createMemoryDb(),
    stores: { integrationSettings: memory.store },
    cipher,
    probe: stub.probe,
  };
  return { deps, stub };
}

describe('probeSmtp：合并与目标归一', () => {
  it('空提交 → 只测存量：pass 解密、port 缺省 465、from 缺省 user', async () => {
    const { deps, stub } = setup([
      smtpRow({
        host: 'smtp.example.com',
        user: 'noreply@example.com',
        pass: cipher.encrypt('s3cret'),
      }),
    ]);
    const result = await probeSmtp(deps, {});
    expect(result).toEqual({ ok: true, durationMs: 7 });
    expect(stub.calls).toEqual([
      {
        host: 'smtp.example.com',
        port: 465,
        user: 'noreply@example.com',
        pass: 's3cret',
        from: 'noreply@example.com',
      },
    ]);
  });

  it('提交 null 清除必填 secret → integration_config_incomplete（三态：null=清除）', async () => {
    const { deps, stub } = setup([
      smtpRow({
        host: 'old.example.com',
        port: '587',
        user: 'noreply@example.com',
        pass: cipher.encrypt('old-pass'),
      }),
    ]);
    await expect(probeSmtp(deps, { config: { pass: null } })).rejects.toMatchObject({
      code: 'control_plane.integration_config_incomplete',
    });
    expect(stub.calls).toEqual([]);
  });

  it('提交值覆盖存量（值=设置 / 缺席=保持）', async () => {
    const { deps, stub } = setup([
      smtpRow({
        host: 'old.example.com',
        port: '587',
        user: 'noreply@example.com',
        pass: cipher.encrypt('old-pass'),
        from: 'noreply@example.com',
      }),
    ]);
    const result = await probeSmtp(deps, {
      config: { host: 'new.example.com', from: 'admin@example.com' },
    });
    expect(result.ok).toBe(true);
    expect(stub.calls).toEqual([
      {
        host: 'new.example.com',
        port: 587,
        user: 'noreply@example.com',
        pass: 'old-pass',
        from: 'admin@example.com',
      },
    ]);
  });

  it('无存量 + 弹窗全新完整提交 → 直接用提交值（pass 明文）', async () => {
    const { deps, stub } = setup();
    const result = await probeSmtp(deps, {
      config: {
        host: 'smtp.example.com',
        port: '465',
        user: 'noreply@example.com',
        pass: 'fresh-pass',
        from: 'Tillgate <noreply@example.com>',
      },
    });
    expect(result.ok).toBe(true);
    expect(stub.calls[0]).toMatchObject({
      host: 'smtp.example.com',
      port: 465,
      pass: 'fresh-pass',
    });
  });
});

describe('probeSmtp：前置校验与结果折叠', () => {
  it('无存量且空提交 → integration_config_incomplete', async () => {
    const { deps } = setup();
    await expect(probeSmtp(deps, {})).rejects.toMatchObject({
      code: 'control_plane.integration_config_incomplete',
    });
  });

  it('提交非法字段值（host 带 scheme）→ integration_field_invalid', async () => {
    const { deps } = setup([
      smtpRow({ host: 'smtp.example.com', user: 'u@example.com', pass: cipher.encrypt('p') }),
    ]);
    await expect(
      probeSmtp(deps, { config: { host: 'smtp://evil.example.com' } }),
    ).rejects.toMatchObject({ code: 'control_plane.integration_field_invalid' });
  });

  it('提交未知字段 → integration_field_invalid', async () => {
    const { deps } = setup([
      smtpRow({ host: 'smtp.example.com', user: 'u@example.com', pass: cipher.encrypt('p') }),
    ]);
    await expect(probeSmtp(deps, { config: { evil: 'x' } })).rejects.toMatchObject({
      code: 'control_plane.integration_field_invalid',
    });
  });

  it('提交 enc: 伪装密文 → integration_secret_encrypted', async () => {
    const { deps } = setup([
      smtpRow({ host: 'smtp.example.com', user: 'u@example.com', pass: cipher.encrypt('p') }),
    ]);
    await expect(probeSmtp(deps, { config: { pass: 'enc:v1:leak' } })).rejects.toMatchObject({
      code: 'control_plane.integration_secret_encrypted',
    });
  });

  it('存量 pass 坏密文 → ok:false 且给出重录诊断（不把密文当密码送探针）', async () => {
    const { deps, stub } = setup([smtpRow({ host: 'h', user: 'u', pass: 'enc:v1:broken' })]);
    const result = await probeSmtp(deps, {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('undecryptable');
    expect(stub.calls).toEqual([]);
  });

  it('上游失败（认证拒绝/不可达）→ 透传探针结果，不是管理面错误', async () => {
    const { deps } = setup(
      [smtpRow({ host: 'smtp.example.com', user: 'u', pass: cipher.encrypt('p') })],
      () => ({ ok: false, durationMs: 42, error: { code: 'auth', message: '535 auth failed' } }),
    );
    await expect(probeSmtp(deps, {})).resolves.toEqual({
      ok: false,
      durationMs: 42,
      error: { code: 'auth', message: '535 auth failed' },
    });
  });

  it('探针适配器抛异常 → 折叠 ok:false internal', async () => {
    const { deps } = setup(
      [smtpRow({ host: 'smtp.example.com', user: 'u', pass: cipher.encrypt('p') })],
      () => {
        throw new Error('adapter exploded');
      },
    );
    const result = await probeSmtp(deps, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'internal', message: 'adapter exploded' });
  });
});
