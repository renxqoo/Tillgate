import Link from "next/link";
import { Compass } from "lucide-react";

import { Card, CardDescription, CardHeader, CardTitle } from "@ai-gateway/ui/components/ui/card";

export function SupportCard() {
  return (
    <Card size="sm" className="overflow-hidden shadow-none group-data-[collapsible=icon]:hidden">
      <CardHeader className="min-w-0 px-4">
        <CardTitle className="flex items-center gap-2 truncate text-sm">
          <Compass className="size-3.5" />
          需要帮助？
        </CardTitle>
        <CardDescription className="line-clamp-3">
          API 接入、计费、套餐变更等问题，联系
          <Link
            href="#"
            className="ml-1 text-foreground hover:underline"
          >
            客服
          </Link>
          。
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
