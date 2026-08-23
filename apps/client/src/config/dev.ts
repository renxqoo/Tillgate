/**
 * dev 演示会话开关（非生产 + DEV_FAKE_ME=1 才生效）：
 * 供 server/session 守卫与 keys 页 mock 提示共用——env 直读收敛在 config/ 单点。
 */
export function isDevFakeMe(): boolean {
  return process.env.DEV_FAKE_ME === '1' && process.env.NODE_ENV !== 'production';
}
