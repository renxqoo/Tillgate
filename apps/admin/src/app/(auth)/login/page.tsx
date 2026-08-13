import { ShieldCheck } from "lucide-react";

import { LoginForm } from "./_components/login-form";
import { APP_CONFIG } from "@/config/app-config";

export default function LoginPage() {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex items-center gap-2 self-start">
          <ShieldCheck className="size-5 text-primary" />
          <span className="font-semibold text-base">{APP_CONFIG.name} 管理后台</span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-sm">
            <LoginForm />
          </div>
        </div>
      </div>

      <div className="relative hidden lg:flex lg:flex-col lg:items-center lg:justify-center bg-muted/30 p-10">
        <div className="max-w-md space-y-4 text-center">
          <div className="inline-flex size-14 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <ShieldCheck className="size-7" />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight">运营后台</h2>
          <p className="text-muted-foreground">
            管理用户账号、调整渠道权重、维护模型映射、生成充值码批次、查看统计与日志。
          </p>
        </div>
      </div>
    </div>
  );
}
