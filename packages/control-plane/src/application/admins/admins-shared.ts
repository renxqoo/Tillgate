/** 管理员资料用例族共享装配（G2）——deps 形状单点,各动词一文件（铁律 5） */
import type { DbLike } from '@tillgate/db';
import type { AdminStore } from '../../ports/admin-store';

export interface AdminsDeps {
  readonly db: DbLike;
  readonly store: AdminStore;
}
