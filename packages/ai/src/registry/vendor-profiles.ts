/**
 * 厂商兼容档案（Vendor Profile）——OpenAI 兼容厂商的参数怪癖预设库。
 *
 * 设计红线：
 *   1. 单一执行引擎：profile 只是 ParamRules 模板，编译后进既有
 *      ignore→map→clamp 引擎（pipeline/prepare 汇合处合并），不建第二套规则引擎；
 *   2. 机制知识进代码不进库表：怪癖是传输层事实，随包发版、带测试快照；
 *      providers.vendor 只存引用字符串（admin 下拉选择）；
 *   3. 只收「已验证」的怪癖：规则错误的代价是破坏真实请求——每条规则必须有
 *      厂商文档/实测依据并配测试；宁缺毋滥，不自造。
 *   4. 仅作用于 openai-compatible 协议族（原生协议适配器自带全部行为）。
 *
 * 合并语义（mergeParamRules）：per-model 规则（DB param_rules）优先于 profile 默认——
 * ignore 取并集、map/clamp 逐键覆盖、unknown 取 model 侧。
 */

import type { ParamRules } from '../types';

/** 厂商档案 = 参数规则模板（+ 人类可读依据，进 admin 展示与测试快照） */
export interface VendorProfile {
  /** 依据（文档/实测来源）——新增 profile 必填，防自造规则 */
  basis: string;
  params: ParamRules;
}

/**
 * 内置档案库（首批：仅含已验证怪癖）。
 * 计划原定首批 8 家——实施时修订：new-api/pi-ai 均无内置参数删除实证，
 * 自造规则破坏真实请求的风险大于收益，故只收有把握的条目，其余待实测补充。
 */
export const VENDOR_PROFILES: Readonly<Record<string, VendorProfile>> = {
  openai: {
    basis: 'OpenAI 文档：o 系列推理模型拒收 max_tokens（400 Unsupported parameter）；max_completion_tokens 为全系列通用现代名',
    params: {
      map: { max_tokens: { to: 'max_completion_tokens' } },
    },
  },
};

/** 档案名词表（admin 下拉/校验单一真相） */
export function vendorProfileNames(): readonly string[] {
  return Object.keys(VENDOR_PROFILES);
}

/** 解析档案（未知 vendor → null：配置错误在 admin-api 校验层拦截，包内不猜） */
export function resolveVendorProfile(vendor: string | undefined): VendorProfile | null {
  if (vendor === undefined || vendor === '') return null;
  return VENDOR_PROFILES[vendor] ?? null;
}

/**
 * 规则合并：profile 默认（厂商家族怪癖）+ per-model 覆盖（DB param_rules）。
 * map/clamp 逐键 model 侧胜出；ignore 并集（两侧都要删的参数没有「不删」语义）；
 * unknown 策略 model 侧优先，缺省回落 profile，再缺省透传。
 */
export function mergeParamRules(
  profile: ParamRules | undefined,
  model: ParamRules | undefined,
): ParamRules {
  if (profile === undefined && model === undefined) return {};
  if (profile === undefined) return model!;
  if (model === undefined) return profile;
  const ignore = [...new Set([...(profile.ignore ?? []), ...(model.ignore ?? [])])];
  return {
    ...(ignore.length > 0 ? { ignore } : {}),
    map: { ...profile.map, ...model.map },
    clamp: { ...profile.clamp, ...model.clamp },
    ...(model.unknown ?? profile.unknown ? { unknown: model.unknown ?? profile.unknown } : {}),
  };
}
