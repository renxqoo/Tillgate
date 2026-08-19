import { createHash } from 'node:crypto';

export const DEFAULT_INTERNAL_ACCOUNT_SHARDS = 16;
export const MAX_INTERNAL_ACCOUNT_SHARDS = 256;

/** Same business reference always reaches the same internal-account shard. */
export function selectInternalShard(refType: string, refId: string, shardCount: number): number {
  const digest = createHash('sha256').update(refType).update('\0').update(refId).digest();
  return digest.readUInt32BE(0) % shardCount;
}
