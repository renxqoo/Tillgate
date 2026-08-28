/**
 * OAuth client_credentials 凭证校验(/oauth/token:client_id + sha256(secret) 双等值,
 * status=0 + 属主 status=0 守卫)。查无统一 null——调用方翻译 invalid_client(不区分原因)。
 */
import { sha256Hex } from '../domain/credentials.js';
import type { ActiveAppRecord } from '../ports/account-store.js';
import type { UseCaseContext } from './context.js';

export function verifyAppClient(
  ctx: UseCaseContext,
  input: { clientId: string; clientSecret: string },
): Promise<ActiveAppRecord | null> {
  return ctx.store.findActiveAppByClient(ctx.db, {
    clientId: input.clientId,
    clientSecretHash: sha256Hex(input.clientSecret),
  });
}
