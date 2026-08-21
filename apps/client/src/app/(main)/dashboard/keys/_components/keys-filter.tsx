"use client";

import { FilterIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

export function KeysStatusFilter({ value }: { value: string }) {
  const router = useRouter();
  const sp = useSearchParams();
  const t = useTranslations("keys");

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
        <option value="all">{t("allStatuses")}</option>
        <option value="0">{t("statusActive")}</option>
        <option value="1">{t("statusRevoked")}</option>
      </select>
    </div>
  );
}
