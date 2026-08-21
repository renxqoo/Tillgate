import Link from "next/link";
import { LifeBuoy } from "lucide-react";

import { Card, CardDescription, CardHeader, CardTitle } from "@ai-gateway/ui/components/ui/card";

export function SupportCard() {
  return (
    <Card size="sm" className="overflow-hidden shadow-none group-data-[collapsible=icon]:hidden">
      <CardHeader className="min-w-0 px-4">
        <CardTitle className="flex items-center gap-2 truncate text-sm">
          <LifeBuoy className="size-3.5" />
          运营支援
        </CardTitle>
        <CardDescription className="line-clamp-3">
          渠道对接 / 故障排查 / 数据导出
          <Link
            href="#"
            className="ml-1 text-foreground hover:underline"
          >
            联系工程师
          </Link>
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
