"use client";

import { useCallback } from "react";

import { toast } from "sonner";

/**
 * Server Action 结果 → toast 的统一封装。
 *
 * 替换遍布各页面的样板：
 *
 *   if (res.error) toast.error("XX失败", { description: res.error });
 *   else toast.success("XX成功");
 *
 * 用法：
 *
 *   const notify = useActionResult();
 *   if (!notify(res, "创建失败", "已创建渠道")) return;
 *   // …成功分支后续逻辑（reset / close）
 *
 * - errorTitle 缺省时与旧代码 `toast.error(res.error)` 一致：直接把错误文案当标题。
 * - success 缺省时不弹成功 toast（保留「仅失败提示」的调用点）。
 * - 返回 boolean：true=成功，方便调用方在成功分支继续收尾。
 */
export function useActionResult() {
  return useCallback(
    <T extends { error?: string }>(
      res: T,
      errorTitle?: string,
      success?: string | ((res: T) => string),
    ): boolean => {
      if (res.error) {
        if (errorTitle === undefined) toast.error(res.error);
        else toast.error(errorTitle, { description: res.error });
        return false;
      }
      if (success !== undefined) {
        toast.success(typeof success === "function" ? success(res) : success);
      }
      return true;
    },
    [],
  );
}
