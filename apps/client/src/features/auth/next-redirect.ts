/**
 * Server Action 内 `redirect()` 的异常形态判别：Next 以 digest 前缀 NEXT_REDIRECT
 * 的异常表达「跳转成功」——手动 `void action().catch()` 形态下该 rejection 会先
 * 到达调用方，必须视为成功信号，不得渲染为失败文案（回归：OAuth 落地页曾把
 * 它当网络错误闪现「登录服务暂不可用」，随后跳转照常完成）。
 */
export function isNextRedirect(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { digest } = error as Error & { digest?: unknown };
  return typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT');
}
