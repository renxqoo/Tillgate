import { SettingsIcon } from "lucide-react";

import { PasswordForm } from "./_components/password-form";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <SettingsIcon className="size-5 text-muted-foreground" />
          设置
        </h1>
        <p className="text-sm text-muted-foreground">管理账户安全设置</p>
      </div>

      <div className="max-w-md">
        <PasswordForm />
      </div>
    </div>
  );
}
