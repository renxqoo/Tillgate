/**
 * 供应商协议与厂商档案词表——过渡快照（IMPLEMENTATION §6 裁决）。
 *
 * 权威源链路：ai 词表 → capabilities → admin-api `GET /v1/vendor-catalog`（admin-api
 * P6）。P6 端点未落地前本文件是 providers 表单的下拉词表快照；后端 zod 契约
 * （control-plane 词表校验）是最终防线——快照失配的后果仅为提交被 400 显式拒绝。
 * P6 落地后删除本文件，改经 admin-api 获取。
 *
 * 快照来源（2026-08-23）：packages/ai src/create-ai.ts defaultAdapters 协议 id
 * + src/registry/vendor-profiles.ts VENDOR_PROFILES 键。封闭性由
 * __test__/config.test.ts 表驱动锁定（增删项须同步本文件与测试）。
 */

/** 可执行协议词表（与 ai SUPPORTED_PROTOCOLS 同值快照） */
export const SUPPORTED_PROTOCOLS: readonly string[] = [
  'openai-compatible',
  'anthropic',
  'gemini',
  'azure-openai',
  'aws-bedrock',
  'vertex-ai',
  'minimax',
  'dashscope',
] as const;

/** 厂商档案词表（与 ai vendorProfileNames() 同值快照） */
export const VENDOR_PROFILE_NAMES: readonly string[] = [
  'openai',
  'deepseek',
  'moonshot',
  'together',
  'nvidia',
  'xai',
  'zai',
] as const;
