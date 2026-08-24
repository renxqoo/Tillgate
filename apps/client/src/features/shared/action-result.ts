import { toast } from '@tillgate/ui';

/**
 * Server Action 结果 → toast 的统一封装（纯函数）。
 *
 *   if (!actionResult(res, '创建失败', '已创建')) return;
 *
 * - errorTitle 缺省时直接把错误文案当标题（v1 语义）；
 * - success 缺省时不弹成功 toast（保留「仅失败提示」的调用点）；
 * - 返回 boolean：true=成功，调用方在成功分支继续收尾。
 */
export function actionResult<T extends { error?: string }>(
  res: T,
  errorTitle?: string,
  success?: string | ((res: T) => string),
): boolean {
  if (res.error) {
    if (errorTitle === undefined) toast.error(res.error);
    else toast.error(errorTitle, { description: res.error });
    return false;
  }
  if (success !== undefined) {
    toast.success(typeof success === 'function' ? success(res) : success);
  }
  return true;
}
