/**
 * 测试助手：stub 资金来源——available='throw' 模拟结构性非法抛错；记录 probe 收到的输入。
 * （plan 阶段纯读，不触 RepoContext；reserve/release 在本套件不可达，调用即炸。）
 */
import { Decimal } from '@ai-gateway/domain';
import type { RepoContext } from '@ai-gateway/repository';
import type { FundingSource, FundingSourceContext } from '../source.js';

export interface StubSourceSpec {
  type: string;
  priority: number;
  available: number | 'throw';
  applies?: boolean;
}

export function makeStubSource(spec: StubSourceSpec): {
  source: FundingSource;
  probed: Array<{ requestId: string; amount: string; context: FundingSourceContext }>;
} {
  const probed: Array<{ requestId: string; amount: string; context: FundingSourceContext }> = [];
  const source: FundingSource = {
    type: spec.type,
    priority: spec.priority,
    applies: () => spec.applies ?? true,
    async probe(_c: RepoContext, input: { requestId: string; amount: string; context: FundingSourceContext }) {
      probed.push({ requestId: input.requestId, amount: input.amount, context: input.context });
      if (spec.available === 'throw') throw new Error(`probe:${spec.type}`);
      return new Decimal(spec.available);
    },
    async reserve() {
      throw new Error('plan 阶段不应 reserve');
    },
    async release() {
      throw new Error('本套件不测 release');
    },
    async settle() {
      throw new Error('本套件不测 settle');
    },
  };
  return { source, probed };
}
