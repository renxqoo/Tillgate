/**
 * 来源注册表：不可变——一次构造、终身只读（没有 register 时机问题）。
 * 工厂闭包捕获来源集；加新来源 = 装配数组加一项，管线零改动。
 */
import type { FundingSource, FundingSourceContext, SourceType } from './source.js';

export interface FundingRegistry {
  get(type: SourceType): FundingSource;
  /** 解析链：applies 过滤 + priority 升序（小先耗——订阅先、PAYG 兜底后） */
  resolve(context: FundingSourceContext): FundingSource[];
}

export function createFundingRegistry(sources: readonly FundingSource[]): FundingRegistry {
  const byType = new Map<string, FundingSource>(sources.map((source) => [source.type, source]));
  return {
    get(type) {
      const source = byType.get(type);
      if (!source) throw new Error(`funding source not registered: ${String(type)}`);
      return source;
    },
    resolve(context) {
      return sources
        .filter((source) => source.applies(context))
        .toSorted((a, b) => a.priority - b.priority);
    },
  };
}
