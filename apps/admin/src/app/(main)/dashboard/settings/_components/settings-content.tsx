"use client";

import { useState, useTransition } from "react";

import { Loader2Icon, ShieldCheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import type { AdminMeInfo } from "@ai-gateway/api-client";
import { Button } from "@ai-gateway/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ai-gateway/ui/components/ui/card";

import { setTwoFactorAction } from "@/lib/server-actions/auth";
import { useActionResult } from "@ai-gateway/ui/components/action-toast";

export function SettingsContent({ me, error }: { me: AdminMeInfo | null; error: string | null }) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();
  const [enabled, setEnabled] = useState(Boolean(me?.twoFactorEnabled));

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">{error}</CardContent>
      </Card>
    );
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheckIcon className="size-4" /> {t("twoFactor")}
        </CardTitle>
        <CardDescription>
          {t("twoFactorDescription", { email: me?.email ?? "—" })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3">
          <Button
            variant={enabled ? "destructive" : "default"}
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const next = !enabled;
                const res = await setTwoFactorAction(next);
                if (notify(res ?? {}, tc("actionFailed"), next ? t("enabledToast") : t("disabledToast"))) setEnabled(next);
              })
            }
          >
            {pending && <Loader2Icon className="animate-spin" />}
            {enabled ? t("disable") : t("enable")}
          </Button>
          <span className="text-sm text-muted-foreground">
            {t("currentStatus")}<span className={enabled ? "text-green-600" : ""}>{enabled ? t("enabledState") : t("disabledState")}</span>
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("smtpHint")}
        </p>
      </CardContent>
    </Card>
  );
}
