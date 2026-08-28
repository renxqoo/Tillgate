/**
 * BFF client-api 装配（app 内唯一后端出口）：
 * 会话 token / accept-language / x-forwarded-for 出口头全部由
 * `@tillgate/api-client/next` 注入。
 * overrides 仅测试注入用（fetch/baseUrl 替身）；页面与 action 一律无参调用。
 */
import type { ClientApiClient } from '@tillgate/api-client';
import { createNextClientApiClient } from '@tillgate/api-client/next';

export type { ClientApiClient };

export function createClientApi(
  overrides: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {},
): ClientApiClient {
  return createNextClientApiClient(overrides);
}
