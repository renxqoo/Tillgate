/**
 * 会话吊销锚点持久化 port(每 (realm, userId) 一行,GREATEST 单调推进——
 * 无状态 JWT 的吊销真相,DESIGN §2.4)。实现见 adapters/postgres/anchors.ts。
 */
import type { DbLike } from '@tillgate/db';

export interface AnchorStore {
  /** 推进吊销线(单调):早于此线的会话全部失效;at 缺省 = SQL now()(B28)。 */
  advanceAnchor(db: DbLike, input: { realm: string; userId: number; at?: Date }): Promise<string>;

  /** 读锚点线(无行 = 全有效) */
  readAnchor(db: DbLike, input: { realm: string; userId: number }): Promise<string | null>;
}
