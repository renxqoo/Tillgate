/** facade admins 面装配 */
import type { Db } from '@tillgate/db';
import type { AdminAccess } from '../../domain/rbac';
import type {
  AdminListQuery,
  AdminListResult,
  AdminRecord,
  AdminStore,
  UpdateAdminRow,
} from '../../ports/admin-store';
import type { CreateAdminInput } from './create-admin';
import { findAdmin } from './find-admin';
import { findAdminByEmail } from './find-admin-by-email';
import { touchLastLogin } from './touch-last-login';
import { setTwoFactorEnabled } from './set-two-factor-enabled';
import { listAdmins } from './list-admins';
import { createAdmin } from './create-admin';
import { updateAdmin } from './update-admin';

export interface AdminsSurface {
  find(id: number): Promise<AdminRecord | null>;
  findByEmail(email: string): Promise<AdminRecord | null>;
  findAccess(adminId: number): Promise<AdminAccess | null>;
  touchLastLogin(adminId: number): Promise<void>;
  setTwoFactorEnabled(input: { adminId: number; enabled: boolean }): Promise<void>;
  list(query: AdminListQuery): Promise<AdminListResult>;
  create(input: CreateAdminInput): Promise<AdminRecord>;
  update(input: UpdateAdminRow): Promise<AdminRecord | null>;
  remove(adminId: number): Promise<void>;
}

export function composeAdminsSurface(db: Db, store: AdminStore): AdminsSurface {
  const deps = { db, store };
  return {
    find: (id) => findAdmin(deps, id),
    findByEmail: (email) => findAdminByEmail(deps, email),
    findAccess: (adminId) => store.findAccess(db, adminId),
    touchLastLogin: (adminId) => touchLastLogin(deps, adminId),
    setTwoFactorEnabled: (input) => setTwoFactorEnabled(deps, input),
    list: (query) => listAdmins(deps, query),
    create: (input) => createAdmin({ db, store }, input),
    update: (input) => updateAdmin(deps, input),
    remove: (adminId) => store.remove(db, adminId),
  };
}
