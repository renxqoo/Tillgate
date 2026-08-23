/**
 * BFF client-api 装配（app 内唯一后端出口）：
 * 会话 token / accept-language / x-forwarded-for 出口头全部由
 * `@tokenlens/api-client/next` 注入（v1 auth 裸 fetch 丢头病灶 B7 的结构性修复）。
 * overrides 仅测试注入用（fetch/baseUrl 替身）；页面与 action 一律无参调用。
 */
import type { ClientApiClient } from '@tokenlens/api-client';
import { createNextClientApiClient } from '@tokenlens/api-client/next';

export type { ClientApiClient };

export function createClientApi(
  overrides: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {},
): ClientApiClient {
  return createNextClientApiClient(overrides);
}
