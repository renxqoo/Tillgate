/** 动态 RBAC 用例族共享装配——deps 形状单点,各动词一文件（铁律 5） */
import type { Db } from '@tokenlens/db';
import type { EndpointStore, PermissionStore, RoleStore } from '../../ports/rbac-store';

export interface RbacDeps {
  readonly db: Db;
  readonly stores: {
    readonly role: RoleStore;
    readonly permission: PermissionStore;
    readonly endpoint: EndpointStore;
  };
}
