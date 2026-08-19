/** channel-budget 装配契约（运营资金自治域——与用户资金永不混账）。 */
import type { Db } from '@ai-gateway/repository';
import type { Repositories } from '@ai-gateway/repository';

export interface ChannelBudgetEnv {
  db: Db;
  clock?: () => Date;
  /** 仓储注入（缺省进程级默认实例） */
  repos?: Repositories;
}
