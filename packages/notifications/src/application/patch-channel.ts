/**
 * 更新渠道:白名单部分更新(type 不可改——config 校验口径与渠道类型绑定)。
 * config 整体替换(PUT 口径):不带 secret 键的 config 会覆盖丢 secret。
 * 词表校验按提交口径:不查库合并旧 events(zod 层 min(1) 已保证非空)。
 */
import type { Db } from '@tillgate/db';
import type { NotifyStore } from '../ports/notify-store';
import type { ChannelPatchInput } from '../ports/notify-store';
import type { SecretCipher } from '../ports/secret-cipher';
import { validateChannelShape, encryptChannelConfig } from '../domain/channel';
import { notificationsErrors } from '../errors';
import { maskChannelRow, type MaskedChannel } from './list-channels';
import type { NotifyContext } from './context';

export interface PatchChannelDeps {
  readonly db: Db;
  readonly store: NotifyStore;
  readonly cipher: SecretCipher;
}

export interface PatchChannelInput {
  readonly ctx: NotifyContext;
  readonly channelId: number;
  readonly patch: ChannelPatchInput;
}

export async function patchChannel(
  deps: PatchChannelDeps,
  input: PatchChannelInput,
): Promise<MaskedChannel> {
  const violation = validateChannelShape(input.patch);
  if (violation) {
    throw notificationsErrors.business('invalid_channel_input', { field: violation });
  }
  const patch: ChannelPatchInput =
    input.patch.config !== undefined
      ? {
          ...input.patch,
          config: encryptChannelConfig(input.patch.config, deps.cipher) as Record<string, unknown>,
        }
      : input.patch;
  const row = await deps.db.transaction((tx) =>
    deps.store.patchChannel(tx, { channelId: input.channelId, patch }),
  );
  if (!row) throw notificationsErrors.business('channel_not_found', { channelId: input.channelId });
  return maskChannelRow(row);
}
