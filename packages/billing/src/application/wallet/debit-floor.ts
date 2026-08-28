/**
 * setDebitFloor 动词：结算透支地板设置（管理面风控口径）。
 * 不动资金、不落交易行——地板只约束结算超收的负余额深度
 * （wallet_assert_account_coherent 触发器消费），语义为「最后写入生效」，
 * 无幂等键需求；审计由调用方（admin 面）自行落 observability。
 * 手工设置标记 source='manual'——批量刷默认（applyDefaultFloor）永不覆盖。
 */
import { BillingErrors } from '../../domain/errors.js';
import { parseNonNegativeAmount } from '../../domain/money.js';
import type { Decimal } from '../../domain/money.js';
import { availableToSpend } from '../../domain/wallet/exposure.js';
import type { AccountSnapshot } from '../../domain/wallet/accounts.js';
import type { TxChannel } from './input.js';
import { withTx } from './posting.js';
import type { WalletEnv } from './wallet.js';

/** 全局默认地板的 settings KV 键（system_configs；单一真相——admin-api 读写共用） */
export const DEBIT_FLOOR_DEFAULT_KEY = 'debit_floor_default';

/** KV 值形状（jsonb，与 billing_timezone 同风格留扩展位）：{"floor":"<非负金额串>"} */
export interface DebitFloorDefaultValue {
  floor?: unknown;
}

/**
 * 解析全局默认地板：未配置/缺字段/非法 → null（= 不套用，列缺省 '0'）。
 * 合法值恒为非负金额串（写入口径同 parseNonNegativeAmount）。
 */
export function parseDebitFloorDefault(raw: unknown): string | null {
  if (raw == null || typeof raw !== 'object') return null;
  const { floor } = raw as DebitFloorDefaultValue;
  if (typeof floor !== 'string' || floor.length === 0) return null;
  try {
    return parseNonNegativeAmount(floor).toString();
  } catch {
    return null;
  }
}

export interface SetDebitFloorInput extends TxChannel {
  userId: number;
  amount: string;
  currency?: string;
}

export interface SetDebitFloorResult {
  debitFloorAfter: string;
}

/** 降低地板的贴线前置校验：新地板必须仍覆盖当前敞口（可用 ≥ −(授信+新地板)） */
function assertFloorCoversExposure(
  account: AccountSnapshot,
  newFloor: Decimal,
  userId: number,
): void {
  const available = availableToSpend(account);
  const minimum = available.plus(newFloor);
  if (minimum.lt(0)) {
    throw BillingErrors.business('debit_floor_conflict', {
      userId,
      available: available.toString(),
      attemptedFloor: newFloor.toString(),
    });
  }
}

export function createSetDebitFloorUseCase(env: WalletEnv) {
  const { store } = env;
  return async function setDebitFloor(input: SetDebitFloorInput): Promise<SetDebitFloorResult> {
    const floor = parseNonNegativeAmount(input.amount);
    await withTx(store, input.tx, async (tx) => {
      const accountId = await store.ensureUserAccount(
        tx,
        input.userId,
        input.currency ?? env.currency,
      );
      const snapshot = await store.userAccountSummaries(tx, input.userId);
      const account = snapshot.find((row) => row.id === accountId);
      if (account == null) {
        throw BillingErrors.business('user_not_found', { userId: input.userId });
      }
      // 前置分类报错（竞态由 deferred 触发器兜底——罕见路径以基础设施错误暴露）
      assertFloorCoversExposure(account, floor, input.userId);
      await store.setDebitFloor(tx, accountId, floor.toString());
    });
    return { debitFloorAfter: floor.toString() };
  };
}

export interface ApplyDefaultFloorInput extends TxChannel {
  floor: string;
}

export interface ApplyDefaultFloorResult {
  applied: number;
  skipped: number;
}

export function createApplyDefaultFloorUseCase(env: WalletEnv) {
  const { store } = env;
  return async function applyDefaultFloor(
    input: ApplyDefaultFloorInput,
  ): Promise<ApplyDefaultFloorResult> {
    const floor = parseNonNegativeAmount(input.floor);
    return withTx(store, input.tx, (tx) =>
      store.applyDefaultFloor(tx, { floor: floor.toString() }),
    );
  };
}
