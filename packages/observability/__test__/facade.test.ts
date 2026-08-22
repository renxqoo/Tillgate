import { describe, expect, it } from 'vitest';
import type { Db } from '@tokenlens/db';
import { createObservability } from '../src/observability';

/**
 * facade 装配形状(control-plane facade.test 先例):四 facet 就位、方法面完整;
 * SQL 行为由 postgres.real.test.ts 承担(装配不触库)。
 */
describe('createObservability', () => {
  it('组装 traces/audit/requestLogs/partitions 四 facet(方法面完整)', () => {
    const observability = createObservability({ db: {} as Db });
    expect(typeof observability.traces.recent).toBe('function');
    expect(typeof observability.traces.traceDetail).toBe('function');
    expect(typeof observability.traces.byRequest).toBe('function');
    expect(typeof observability.traces.topology).toBe('function');
    expect(typeof observability.traces.stats).toBe('function');
    expect(typeof observability.audit.list).toBe('function');
    expect(typeof observability.audit.listByTarget).toBe('function');
    expect(typeof observability.requestLogs.insert).toBe('function');
    expect(typeof observability.requestLogs.list).toBe('function');
    expect(typeof observability.partitions.traces).toBe('function');
    expect(typeof observability.partitions.requestLogs).toBe('function');
  });
});
