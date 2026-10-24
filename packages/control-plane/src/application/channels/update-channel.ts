/**
 * 更新渠道。换 Key 语义：重加密 + 复位运行态（status=0 / failCount=0 / cooldownUntil=null /
 * usageEvidenceDefects=0——「换 Key = 修死凭据 + 运维复核通过」：死凭据 status=4 / 熔断
 * status=3 一并清除，缺陷计数同步清零防反复弹回（issue #80））。
 * 启用语义：patch status→0 且当前非 0 = 运维复核通过，缺陷计数一并清零。
 */
import type { Db } from '@tillgate/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { SecretCipher } from '../../ports/secret-cipher';
import type { ChannelStore } from '../../ports/channel-store';
import type { ChannelPatchInput } from '../../domain/channel/channel';
import { validateChannelPatch } from '../../domain/channel/channel';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface UpdateChannelDeps {
  readonly db: Db;
  readonly stores: { readonly channel: ChannelStore };
  readonly cipher: SecretCipher;
  readonly audit: AuditSink;
}

export interface UpdateChannelInput {
  readonly ctx: ControlContext;
  readonly channelId: number;
  readonly patch: ChannelPatchInput;
}

export interface UpdatedChannel {
  readonly id: number;
  readonly name: string;
  readonly status: number;
  readonly failCount: number;
}

export async function updateChannel(
  deps: UpdateChannelDeps,
  input: UpdateChannelInput,
): Promise<UpdatedChannel> {
  const validated = validateChannelPatch(input.patch);
  const { apiKey, upstreamThreshold, ...rest } = validated;
  const keyChanged = apiKey !== undefined;
  const row = await deps.db.transaction((tx) => {
    const patch: Parameters<typeof deps.stores.channel.updateChannel>[1]['patch'] = {
      ...rest,
      ...(upstreamThreshold !== undefined ? { upstreamThreshold } : {}),
      ...(keyChanged
        ? {
            apiKeyEnc: deps.cipher.encrypt(apiKey),
            // 换 Key 即复位运行态（服务层一并用词——store 端不感知运维语义）；
            // 计数无条件清零：换 Key = 复核通过，与当前状态无关（单 UPDATE 原子）
            status: 0,
            failCount: 0,
            cooldownUntil: null,
            usageEvidenceDefects: 0,
          }
        : {}),
    };
    // 启用即复核：patch 把 status 改回 0 时缺陷计数按「当前非 0」守卫清零。
    // 守卫判定下沉 store 的 SQL 单语句（case when status <> 0）——应用层不得
    // SELECT 现态拼值：READ COMMITTED 下并发熔断的 EPQ 重放会让读-判-写产生
    // 「status 复位、计数未清」的半应用态（issue #80 路 B finding #1）
    if (validated.status === 0) patch.resetUsageDefects = true;
    return deps.stores.channel.updateChannel(tx, { channelId: input.channelId, patch });
  });
  if (!row) {
    throw controlPlaneErrors.business('channel_not_found', { channelId: input.channelId });
  }
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId: adminIdOf(input.ctx),
    action: 'channel.update',
    targetType: 'channel',
    targetId: row.id,
    // 审计不带密钥事实——只有「换没换」与改名事实
    detail: { keyChanged, ...(validated.name !== undefined ? { name: validated.name } : {}) },
  });
  return row;
}
