/**
 * 订阅换绑(v1 credential.rebindCredentials):把绑定旧订阅的 Key 与 App 改绑新订阅
 * (续费场景;G6:调用方是 billing 订阅续费用例,经装配桥接)。单事务双表。
 */
import { runTx } from '@tokenlens/db';
import type { UseCaseContext } from './context.js';

export function rebindSubscription(
  ctx: UseCaseContext,
  input: { fromSubscriptionId: number; toSubscriptionId: number },
): Promise<{ keys: number; apps: number }> {
  return runTx(
    ctx.db,
    (tx) => ctx.store.rebindSubscription(tx, input),
    ctx.txRetry,
  );
}
