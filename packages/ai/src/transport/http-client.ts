/** fetch 封装：connect 超时 / abort 信号 / URL 校验（骨架） */
// TODO(ai): connectMs 超时、AbortSignal 传播、URL/SSRF 校验（https only + 禁内网）
export function assertSafeUrl(url: string): void {
  const u = new URL(url)
  if (u.protocol !== 'https:') throw new Error(`unsupported protocol: ${u.protocol}`)
  // TODO(ai): 禁内网/回环地址校验
}
