/**
 * 创建渠道：密钥即加密落库（enc:v1；明文只在加密前内存存在）→ 事务落库 → 审计。
 * 返回体永不带密文与明文。重名由唯一索引兜底（channels_name_uq）。
 */
import { isUniqueViolation, type Db } from '@tokenlens/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { SecretCipher } from '../../ports/secret-cipher';
import type { ChannelStore } from '../../ports/channel-store';
import type { ChannelCreateInput } from '../../domain/channel/channel';
import { validateChannelCreate } from '../../domain/channel/channel';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface CreateChannelDeps {
  readonly db: Db;
  readonly stores: { readonly channel: ChannelStore };
  readonly cipher: SecretCipher;
  readonly audit: AuditSink;
}

export type CreateChannelInput = {
  readonly ctx: ControlContext;
} & ChannelCreateInput;

export interface CreatedChannel {
  readonly id: number;
  readonly name: string;
  readonly providerId: number;
}

export async function createChannel(
  deps: CreateChannelDeps,
  input: CreateChannelInput,
): Promise<CreatedChannel> {
  const { ctx, ...rest } = input;
  const validated = validateChannelCreate(rest);
  const apiKeyEnc = deps.cipher.encrypt(validated.apiKey);
  let row: CreatedChannel;
  try {
    row = await deps.db.transaction((tx) =>
      deps.stores.channel.insertChannel(tx, {
        providerId: validated.providerId,
        name: validated.name,
        apiKeyEnc,
        baseUrlOverride: validated.baseUrlOverride ?? null,
        models: validated.models ?? null,
        weight: validated.weight,
        priority: validated.priority,
        rpmLimit: validated.rpmLimit ?? null,
        tpmLimit: validated.tpmLimit ?? null,
      }),
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw controlPlaneErrors.business('channel_exists', { name: validated.name });
    }
    throw error;
  }
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId: adminIdOf(ctx),
    action: 'channel.create',
    targetType: 'channel',
    targetId: row.id,
    detail: { name: row.name, providerId: row.providerId },
  });
  return row;
}
