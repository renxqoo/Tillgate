/**
 * 创建渠道:形状校验(B1 收口口径)→ secret 加密落库 → 唯一索引兜底重名(23505 → channel_exists)。
 */
import { isUniqueViolation, type Db } from '@tillgate/db';
import type { NotifyStore } from '../ports/notify-store';
import type { SecretCipher } from '../ports/secret-cipher';
import { validateChannelShape, encryptChannelConfig } from '../domain/channel';
import type { ChannelType } from '../domain/channel';
import { notificationsErrors } from '../errors';
import { maskChannelRow, type MaskedChannel } from './list-channels';
import type { NotifyContext } from './context';

export interface CreateChannelDeps {
  readonly db: Db;
  readonly store: NotifyStore;
  readonly cipher: SecretCipher;
}

export interface CreateChannelInput {
  readonly ctx: NotifyContext;
  readonly name: string;
  readonly type: ChannelType;
  readonly config: Record<string, unknown>;
  readonly events: string[];
  readonly status?: number;
}

export async function createChannel(
  deps: CreateChannelDeps,
  input: CreateChannelInput,
): Promise<MaskedChannel> {
  const { ctx: _ctx, ...rest } = input;
  const violation = validateChannelShape(rest);
  if (violation) {
    throw notificationsErrors.business('invalid_channel_input', { field: violation });
  }
  const config = encryptChannelConfig(rest.config, deps.cipher);
  let row;
  try {
    row = await deps.db.transaction((tx) =>
      deps.store.insertChannel(tx, {
        name: rest.name,
        type: rest.type,
        config: config as Record<string, unknown>,
        events: rest.events,
        status: rest.status,
      }),
    );
  } catch (error) {
    // 重名交给唯一索引(并发下前置查重有窗口,索引是结构兜底)
    if (isUniqueViolation(error)) {
      throw notificationsErrors.business('channel_exists', { name: rest.name });
    }
    throw error;
  }
  return maskChannelRow(row);
}
