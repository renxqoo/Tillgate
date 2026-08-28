/** 管理员资料用例族共享装配——deps 形状单点,各动词一文件 */
import type { DbLike } from '@tillgate/db';
import type { AdminStore } from '../../ports/admin-store';

export interface AdminsDeps {
  readonly db: DbLike;
  readonly store: AdminStore;
}
