/**
 * 批量导入渠道（best-effort）：逐条事务；单条失败不中断批次（全败由调用方按 success 判定拒绝）。
 * 供应商按名精确解析（miss = 该条失败）；同名渠道拒绝；
 * 目录条目按外部名绑定映射（缺映射跳过——目录名未建映射不算错）。
 */
import { isUniqueViolation, type Db } from '@tokenlens/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { SecretCipher } from '../../ports/secret-cipher';
import type { ChannelStore } from '../../ports/channel-store';
import type { ProviderStore } from '../../ports/provider-store';
import type { ModelStore } from '../../ports/model-store';
import type { ChannelImportItem } from '../../domain/channel/channel';
import { validateChannelImportItem } from '../../domain/channel/channel';
import { isBusinessError } from '@tokenlens/errors';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface ImportChannelsDeps {
  readonly db: Db;
  readonly stores: {
    readonly channel: ChannelStore;
    readonly provider: ProviderStore;
    readonly model: ModelStore;
  };
  readonly cipher: SecretCipher;
  /** 单批条目上限（装配注入） */
  readonly importMax: number;
  readonly audit: AuditSink;
}

export interface ImportChannelsInput {
  readonly ctx: ControlContext;
  readonly channels: ChannelImportItem[];
}

export interface ImportChannelDetail {
  readonly index: number;
  readonly ok: boolean;
  readonly channelId?: number;
  readonly name?: string;
  readonly error?: string;
}

export interface ImportChannelsResult {
  readonly total: number;
  readonly success: number;
  readonly failed: number;
  readonly details: ImportChannelDetail[];
}

export async function importChannels(
  deps: ImportChannelsDeps,
  input: ImportChannelsInput,
): Promise<ImportChannelsResult> {
  if (input.channels.length === 0) {
    throw controlPlaneErrors.business('import_empty');
  }
  if (input.channels.length > deps.importMax) {
    throw controlPlaneErrors.business('import_limit_exceeded', { limit: deps.importMax });
  }
  const details: ImportChannelDetail[] = [];
  let success = 0;

  for (const [index, raw] of input.channels.entries()) {
    try {
      const item = validateChannelImportItem(raw);
      // 供应商按名精确解析（miss = 该条失败，不中断批次）
      const provider = await deps.stores.provider.findByName(deps.db, item.provider);
      if (!provider) {
        throw controlPlaneErrors.business('provider_not_found', { provider: item.provider });
      }
      const existing = await deps.stores.channel.findChannelByName(deps.db, item.name);
      if (existing) {
        throw controlPlaneErrors.business('channel_exists', { name: item.name });
      }
      const created = await deps.db.transaction(async (tx) => {
        const channel = await deps.stores.channel.insertChannel(tx, {
          providerId: provider.id,
          name: item.name,
          apiKeyEnc: deps.cipher.encrypt(item.apiKey),
          weight: item.weight ?? 1,
          priority: item.priority ?? 0,
        });
        // 目录条目按外部名绑定（缺映射跳过——目录名未建映射不算错）
        for (const modelName of item.models ?? []) {
          const mapping = await deps.stores.model.findByExternalName(tx, modelName);
          if (mapping) {
            await deps.stores.model.ensureModelChannelBinding(tx, {
              mappingId: mapping.id,
              channelId: channel.id,
            });
          }
        }
        return channel;
      });
      success += 1;
      details.push({ index, ok: true, channelId: created.id, name: item.name });
    } catch (e) {
      // 单条失败不裸漏 PG 内部：业务错误用目录文案，唯一冲突给同名义，其余统一收口
      details.push({
        index,
        ok: false,
        name: raw.name,
        error: importItemErrorMessage(e),
      });
    }
  }

  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId: adminIdOf(input.ctx),
    action: 'channel.import',
    targetType: 'channel',
    detail: { total: input.channels.length, success },
  });
  return {
    total: input.channels.length,
    success,
    failed: input.channels.length - success,
    details,
  };
}

function importItemErrorMessage(e: unknown): string {
  if (isBusinessError(e)) return e.message;
  if (isUniqueViolation(e)) return 'Channel with the same name already exists';
  return 'Import failed (data conflict or validation failure)';
}
