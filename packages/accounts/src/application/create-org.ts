/**
 * 创建组织(v1 insertOrgWithOwner):org + owner 成员行(占 1 席)同事务;
 * 组织名由调用方组合(G7:购买场景的命名模板归 billing 编排)。
 */
import { runTx } from '@tillgate/db';
import { AccountsErrors } from '../domain/errors.js';
import { normalizeName } from '../domain/fields.js';
import type { OrgRecord } from '../ports/account-store.js';
import type { UseCaseContext } from './context.js';

export async function createOrg(
  ctx: UseCaseContext,
  input: { ownerUserId: number; name: string },
): Promise<OrgRecord> {
  const name = normalizeName(input.name);
  if (name === null) throw AccountsErrors.business('org_name_invalid');
  if (!(await ctx.store.userExists(ctx.db, input.ownerUserId))) {
    throw AccountsErrors.business('user_not_found', { userId: input.ownerUserId });
  }
  return runTx(
    ctx.db,
    (tx) => ctx.store.insertOrgWithOwner(tx, { name, ownerUserId: input.ownerUserId }),
    ctx.txRetry,
  );
}
