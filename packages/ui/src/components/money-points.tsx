import { useTranslations } from "next-intl";

import { formatMoney, formatPoints } from "@ai-gateway/api-client/formatters";

/**
 * 钱 + 积分并列展示（纯展示层，积分 = 元 × 100）。
 * 合并 admin plans / subscriptions 两份相同实现。
 */
export function MoneyPoints({ value }: { value: string }) {
  const t = useTranslations("ui");
  return (
    <span className="tabular-nums">
      <span className="font-medium">¥{formatMoney(value)}</span>
      <span className="ml-1.5 text-xs text-muted-foreground">
        {formatPoints(value)} {t("points")}
      </span>
    </span>
  );
}
