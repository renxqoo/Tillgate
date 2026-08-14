"use client";

import { BriefcaseIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";

export function UsersEnterpriseFilter({ value }: { value: string }) {
  const router = useRouter();
  const sp = useSearchParams();

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = new URLSearchParams(sp.toString());
    if (e.target.value === "all") next.delete("enterprise");
    else next.set("enterprise", e.target.value);
    router.push(`?${next.toString()}`);
  }

  return (
    <div className="relative">
      <BriefcaseIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <select
        onChange={onChange}
        defaultValue={value}
        className="h-9 w-32 appearance-none rounded-md border border-input bg-transparent pl-9 pr-3 text-sm shadow-xs focus-visible:ring-1 focus-visible:ring-ring"
      >
        <option value="all">全部类型</option>
        <option value="1">企业</option>
        <option value="0">个人</option>
      </select>
    </div>
  );
}
