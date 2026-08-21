"use client";

import { FilterIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";

export function SubscriptionsStatusFilter({ value }: { value: string }) {
  const router = useRouter();
  const sp = useSearchParams();
  const tc = useTranslations("common");
  const t = useTranslations("subscriptions");

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = new URLSearchParams(sp.toString());
    if (e.target.value === "all") next.delete("status");
    else next.set("status", e.target.value);
    next.delete("page");
    router.push(`?${next.toString()}`);
  }

  return (
    <div className="relative">
      <FilterIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <select
        onChange={onChange}
        defaultValue={value}
        className="h-9 w-32 appearance-none rounded-md border border-input bg-transparent pl-9 pr-3 text-sm shadow-xs focus-visible:ring-1 focus-visible:ring-ring"
      >
        <option value="all">{tc("allStatuses")}</option>
        <option value="0">{t("statusActive")}</option>
        <option value="1">{t("statusExpired")}</option>
        <option value="2">{t("statusCancelled")}</option>
      </select>
    </div>
  );
}
