"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { FilterIcon, SearchIcon } from "lucide-react";

import { Button } from "@ai-gateway/ui/components/ui/button";
import { Input } from "@ai-gateway/ui/components/ui/input";

export function UsageLogsFilter({
  from,
  to,
  userId,
  estimated,
}: {
  from: string;
  to: string;
  userId: string;
  estimated: string;
}) {
  const router = useRouter();
  const sp = useSearchParams();

  function apply(next: Record<string, string>) {
    const params = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    router.push(`?${params.toString()}`);
  }

  function reset() {
    const params = new URLSearchParams(sp.toString());
    params.delete("from");
    params.delete("to");
    params.delete("userId");
    params.delete("estimated");
    router.push(`?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">起始日期</label>
        <Input
          type="date"
          defaultValue={from}
          onChange={(e) => apply({ from: e.target.value })}
          className="h-9 w-40"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">结束日期</label>
        <Input
          type="date"
          defaultValue={to}
          onChange={(e) => apply({ to: e.target.value })}
          className="h-9 w-40"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">用户 ID</label>
        <Input
          defaultValue={userId}
          placeholder="可选"
          onKeyDown={(e) => {
            if (e.key === "Enter") apply({ userId: (e.target as HTMLInputElement).value });
          }}
          className="h-9 w-32"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">计费方式</label>
        <div className="relative">
          <FilterIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <select
            defaultValue={estimated}
            onChange={(e) => apply({ estimated: e.target.value })}
            className="h-9 w-36 appearance-none rounded-md border border-input bg-transparent pl-9 pr-3 text-sm shadow-xs focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="">全部计费</option>
            <option value="true">仅估算扣款</option>
            <option value="false">仅真实用量</option>
          </select>
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={reset} className="h-9">
        <SearchIcon /> 重置
      </Button>
    </div>
  );
}
