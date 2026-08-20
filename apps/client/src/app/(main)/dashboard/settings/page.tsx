import { SettingsIcon, ShieldCheckIcon } from "lucide-react";

import { fmtDateTime, formatMoney } from "@ai-gateway/api-client/formatters";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ai-gateway/ui/components/ui/card";

import { requireMe } from "@/lib/server/get-user";

import { DisplayNameDialog } from "./_components/display-name-dialog";
import { PasswordDialog } from "./_components/password-dialog";

export const dynamic = "force-dynamic";

function InfoRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-2.5 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium break-all text-right">{value}</span>
    </div>
  );
}

export default async function SettingsPage() {
  const me = await requireMe();
  const balance = me.accounts.find((account) => account.currency === 'CNY')?.balance ?? '0';

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <SettingsIcon className="size-5 text-muted-foreground" />
          账户设置
        </h1>
        <p className="text-sm text-muted-foreground">账户信息与安全设置</p>
      </div>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="text-base">账户信息</CardTitle>
          <CardDescription>当前登录账户的基本信息与限额</CardDescription>
          <CardAction>
            <DisplayNameDialog current={me.displayName || me.subject} />
          </CardAction>
        </CardHeader>
        <CardContent>
          <InfoRow label="显示名称" value={me.displayName || me.subject} />
          <InfoRow label="邮箱" value={me.email ?? "—"} />
          <InfoRow label="账户余额" value={`¥${formatMoney(balance)}`} />
          <InfoRow label="费率卡" value={me.rateCardName ?? "—"} />
          <InfoRow label="账户类型" value={me.isEnterprise ? "企业账户" : "个人账户"} />
          <InfoRow
            label="速率限制"
            value={
              me.rpmLimit == null || me.tpmLimit == null
                ? "—"
                : `${me.rpmLimit.toLocaleString()} RPM / ${(me.tpmLimit / 10000).toLocaleString(undefined, { maximumFractionDigits: 1 })}万 TPM`
            }
          />
          <InfoRow label="最近登录" value={fmtDateTime(me.lastLoginAt)} />
          <InfoRow label="注册时间" value={fmtDateTime(me.createdAt)} />
        </CardContent>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheckIcon className="size-4 text-muted-foreground" />
            安全设置
          </CardTitle>
          <CardDescription>定期更换密码有助于保障账户安全</CardDescription>
          <CardAction>
            <PasswordDialog />
          </CardAction>
        </CardHeader>
      </Card>
    </div>
  );
}
