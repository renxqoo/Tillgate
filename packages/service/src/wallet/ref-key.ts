/** 幂等键契约：refType 白名单 + refId 形状（1-128 可见字符）。 */
import { assertRefId, assertRefType, type WalletGuards } from '@ai-gateway/domain';

export function assertRefKey(guards: WalletGuards, refType: string, refId: string): void {
  assertRefType(guards, refType);
  assertRefId(refId);
}
