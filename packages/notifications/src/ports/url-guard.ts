/**
 * SSRF 断言 port:管理员配置的 webhook URL 不得成为内网探测跳板。
 * 原语单一真相在 ai 包(https-only + 私网/回环/metadata 段全拒 + DNS 逐地址判定防 rebinding);
 * 本包禁依赖 ai(总纲 §5.1 白名单),装配注入 ai.assertSafeUrl。
 * 允许回环/私网的 dev/test 逃生门是装配层双门(env 允许且非生产),不进本包。
 */
export interface UrlGuard {
  /** 不安全时抛错(与 ai.assertSafeUrl 同契约);返回解析出的 URL 供实现复用 */
  assert(url: string, opts: { allowLocal: boolean }): Promise<URL>;
}
