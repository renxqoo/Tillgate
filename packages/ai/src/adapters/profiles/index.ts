import type { ParamRules } from '../../types.js';

/**
 * provider profile：各家默认参数抹平规则（代码内置默认，DB param_rules per-model 覆盖）。
 * 联调后校准（新增/调整只需改这里或 DB 配置，不动适配器代码）。
 */
export interface ProviderProfile {
  providerName: string;
  /** 内置默认规则（unknown 恒为 passthrough，除非显式声明） */
  rules: ParamRules;
}

export const profiles: Record<string, ProviderProfile> = {
  deepseek: { providerName: 'deepseek', rules: {} },
  openai: { providerName: 'openai', rules: {} },
  minimax: { providerName: 'minimax', rules: {} },
  glm: { providerName: 'glm', rules: {} },
  qwen: { providerName: 'qwen', rules: {} },
};

export function loadProfile(providerName: string): ProviderProfile | undefined {
  return profiles[providerName];
}

/** profile 默认 + per-model 覆盖（per-model 优先） */
export function mergeRules(profile?: ProviderProfile, modelRules?: ParamRules): ParamRules {
  return {
    ...profile?.rules,
    ...modelRules,
    ignore: [...(profile?.rules.ignore ?? []), ...(modelRules?.ignore ?? [])],
    clamp: { ...profile?.rules.clamp, ...modelRules?.clamp },
    map: { ...profile?.rules.map, ...modelRules?.map },
    unknown: modelRules?.unknown ?? profile?.rules.unknown ?? 'passthrough',
  };
}
