/** 装配层：createLedger(db, options) → 3 个动词（run / operation / operations） */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { InvalidInputError } from './errors.js';
import { getOperation, listOperations, runOperation } from './operations.js';
import { buildGuards, KIND_VOCAB_RE } from './validation.js';
import type { CreateLedgerOptions, Ledger } from './types.js';

/** 全量配置校验：坏配置不带进运行期（kinds 必填非空、形状与去重 fail fast） */
function resolveGuards(options: CreateLedgerOptions) {
  if (options == null || !Array.isArray(options.kinds) || options.kinds.length === 0) {
    throw new InvalidInputError('kinds', 'must be a non-empty array (fail-closed whitelist)');
  }
  for (const kind of options.kinds) {
    if (typeof kind !== 'string' || !KIND_VOCAB_RE.test(kind)) {
      throw new InvalidInputError('kinds', `entry '${String(kind)}' must match ${KIND_VOCAB_RE.source}`);
    }
  }
  if (new Set(options.kinds).size !== options.kinds.length) {
    throw new InvalidInputError('kinds', 'duplicate entries');
  }
  return buildGuards(options.kinds);
}

export function createLedger(db: NodePgDatabase, options: CreateLedgerOptions): Ledger {
  const guards = resolveGuards(options);
  const effects = options.effects;
  return {
    run: (input) => runOperation(db, input, guards, effects),
    operation: (input) => getOperation(db, input),
    operations: (input) => listOperations(db, input),
  };
}
