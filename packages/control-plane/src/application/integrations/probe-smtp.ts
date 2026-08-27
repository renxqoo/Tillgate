/**
 * SMTP 集成连通性探针：合并「存量配置 + 弹窗当前提交值」（三态，不落库）
 * → 完整性校验 → 委托 SmtpProbe port 真实连接 + 登录认证（不发送邮件）。
 * 探针适配器异常与上游失败（不可达/认证拒绝/超时）都是探针结果（ok:false），
 * 不是管理面错误——与 probe-channel 同语义；本用例不写库、不留审计。
 */
import { isConfigComplete } from '../../domain/integrations/completeness';
import { specOf } from '../../domain/integrations/specs';
import { controlPlaneErrors } from '../../errors';
import type { Db } from '@tillgate/db';
import type { SecretCipher } from '../../ports/secret-cipher';
import type { IntegrationSettingsStore } from '../../ports/integration-settings-store';
import type { SmtpProbe, SmtpProbeTarget } from '../../ports/smtp-probe';
import { mergeIntegrationPlaintext } from './merge-plaintext';

export interface ProbeSmtpDeps {
  readonly db: Db;
  readonly stores: { readonly integrationSettings: IntegrationSettingsStore };
  readonly cipher: SecretCipher;
  readonly probe: SmtpProbe;
}

export interface ProbeSmtpInput {
  /** 弹窗当前填写值（字段三态：缺席=保持存量 / null=清除 / 值=设置；空 = 只测存量） */
  readonly config?: Readonly<Record<string, string | null>>;
}

export interface ProbeSmtpResult {
  readonly ok: boolean;
  readonly durationMs: number;
  readonly error?: { readonly code: string; readonly message: string };
}

/** SMTP 缺省端口（与 resolve-snapshot 的快照归一同口径） */
const SMTP_DEFAULT_PORT = 465;

export async function probeSmtp(
  deps: ProbeSmtpDeps,
  input: ProbeSmtpInput,
): Promise<ProbeSmtpResult> {
  const spec = specOf('smtp');
  const rows = await deps.stores.integrationSettings.readAll(deps.db);
  const existing = rows.find((row) => row.key === 'smtp');
  const { merged, undecryptable } = mergeIntegrationPlaintext(deps.cipher, spec, {
    stored: existing?.config ?? {},
    submitted: input.config ?? {},
  });
  if (!isConfigComplete(spec, merged)) {
    throw controlPlaneErrors.business('integration_config_incomplete', { key: 'smtp' });
  }
  if (undecryptable.has('pass')) {
    // 存量密文不可解（根密钥漂移）——不把密文当密码送探针（误导性认证失败），
    // 直接给出可行动诊断；重录密码（写入路径原样回写语义）即可恢复
    return {
      ok: false,
      durationMs: 0,
      error: {
        code: 'internal',
        message: 'stored pass is undecryptable; re-enter the password to recover',
      },
    };
  }
  const startedAt = Date.now();
  try {
    const result = await deps.probe.probeSmtp(targetOf(merged));
    return {
      ok: result.ok,
      durationMs: result.durationMs,
      ...(result.error !== undefined
        ? { error: { code: result.error.code, message: result.error.message } }
        : {}),
    };
  } catch (error) {
    // 适配器异常（含坏密文导致的构造失败）都是探针结果——不炸管理面
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
    };
  }
}

/** 合并视图 → 探针目标（port 缺省 465 / from 缺省 user，与 resolveSmtp 同口径） */
function targetOf(merged: Record<string, string>): SmtpProbeTarget {
  const user = merged.user as string;
  return {
    host: merged.host as string,
    port: merged.port != null ? Number(merged.port) : SMTP_DEFAULT_PORT,
    user,
    pass: merged.pass as string,
    from: merged.from ?? user,
  };
}
