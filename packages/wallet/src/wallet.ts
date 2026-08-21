/**
 * 通用资金钱包（复式账本，业务无关）——动词装配层。
 * 每个动词一个文件；复式模型：每笔资金交易 = 批头（幂等键）+ ≥2 腿（Σ=0）。
 * credit/settle/refund 自动生成对手腿（内部科目）；transfer 原子转账；
 * freeze 风控冻结。资金不变量见 README（DB check 兜底 + 代码保证 + 对账测试）。
 */
import { z } from 'zod';
import { credit } from './credit';
import { authorize } from './authorize';
import { settle } from './settle';
import { release } from './release';
import { refund } from './refund';
import { transfer } from './transfer';
import { setCreditLimit } from './credit-line';
import { freeze } from './freeze';
import { accounts, balance } from './balance';
import { statement } from './statement';
import { observe } from './telemetry';
import type { CreateWalletOptions, Wallet } from './types';
import { DEFAULT_CURRENCY, OUTSIDE_ACCOUNT, REVENUE_ACCOUNT } from './types';
import type { ValidationGuards } from './validation';
import {
  accountCodeSchema,
  currencySchema,
  parseWithWalletError,
  refTypeSchema,
} from './validation';
import { DEFAULT_INTERNAL_ACCOUNT_SHARDS, MAX_INTERNAL_ACCOUNT_SHARDS } from './sharding';
import type { AnyPgDatabase } from './internal';

/** 白名单数组约束：逐项过词表格式，重复即拒（重复几乎必是复制粘贴错，启动即拦） */
function whitelist(schema: z.ZodString, message: string) {
  return z
    .array(schema)
    .refine((values) => new Set(values).size === values.length, { message });
}

const shardsRangeMessage = `must be an integer between 1 and ${MAX_INTERNAL_ACCOUNT_SHARDS}`;

/** 配置契约：三张白名单（fail-closed）+ 分片范围 + defaultCurrency 归属——一次 parse 全量校验 */
const createWalletOptionsSchema = z
  .object({
    accounts: whitelist(accountCodeSchema, 'accounts must not contain duplicates'), // 可空：内置科目免声明
    refTypes: whitelist(refTypeSchema, 'refTypes must not contain duplicates').min(
      1,
      'refTypes must not be empty',
    ),
    currencies: whitelist(currencySchema, 'currencies must not contain duplicates').min(
      1,
      'currencies must not be empty',
    ),
    internalAccountShards: z
      .number()
      .int(shardsRangeMessage)
      .gte(1, shardsRangeMessage)
      .lte(MAX_INTERNAL_ACCOUNT_SHARDS, shardsRangeMessage)
      .default(DEFAULT_INTERNAL_ACCOUNT_SHARDS),
    defaultCurrency: currencySchema.default(DEFAULT_CURRENCY),
  })
  .refine((cfg) => cfg.currencies.includes(cfg.defaultCurrency), {
    message: 'defaultCurrency must be one of currencies',
    path: ['defaultCurrency'],
  });

export function createWallet(db: AnyPgDatabase, options: CreateWalletOptions): Wallet {
  const cfg = parseWithWalletError(createWalletOptionsSchema, options, 'options');
  const { telemetry } = options;
  // 三张白名单必填（fail-closed）；内置科目恒并入 accounts 集合
  const guards: ValidationGuards = {
    refTypes: new Set(cfg.refTypes),
    currencies: new Set(cfg.currencies),
    accountCodes: new Set([OUTSIDE_ACCOUNT, REVENUE_ACCOUNT, ...cfg.accounts]),
    defaultCurrency: cfg.defaultCurrency,
    telemetry,
    internalAccountShards: cfg.internalAccountShards,
  };
  return {
    credit: (input) => observe(telemetry, 'credit', () => credit(db, input, guards)),
    authorize: (input) => observe(telemetry, 'authorize', () => authorize(db, input, guards)),
    settle: (input) => observe(telemetry, 'settle', () => settle(db, input, guards)),
    release: (input) => observe(telemetry, 'release', () => release(db, input, guards)),
    refund: (input) => observe(telemetry, 'refund', () => refund(db, input, guards)),
    transfer: (input) => observe(telemetry, 'transfer', () => transfer(db, input, guards)),
    setCreditLimit: (input) => observe(telemetry, 'setCreditLimit', () => setCreditLimit(db, input, guards)),
    freeze: (input) => observe(telemetry, 'freeze', () => freeze(db, input, guards)),
    balance: (userId, currency) => observe(telemetry, 'balance', () => balance(db, userId, currency ?? cfg.defaultCurrency, guards)),
    accounts: (userId) => observe(telemetry, 'accounts', () => accounts(db, userId, guards)),
    statement: (input) => observe(telemetry, 'statement', () => statement(db, input, guards)),
  };
}

export { DEFAULT_CURRENCY };
