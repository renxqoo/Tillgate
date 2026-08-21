"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Building2, Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@ai-gateway/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ai-gateway/ui/components/ui/card";
import { useActionResult } from "@ai-gateway/ui/components/action-toast";

export function AcceptInvite({ token }: { token: string }) {
  const t = useTranslations("orgs");
  const router = useRouter();
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();

  if (!token) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">{t("missingToken")}</CardContent>
      </Card>
    );
  }

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Building2 className="size-5 text-muted-foreground" />
          {t("pageTitle")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("pageSubtitle")}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("joinTitle")}</CardTitle>
          <CardDescription>{t("joinDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          {done ? (
            <div className="space-y-2">
              <p className="text-sm text-emerald-600">{t("joinedNotice")}</p>
              <Button onClick={() => router.push("/dashboard/orgs")}>{t("goOrgs")}</Button>
            </div>
          ) : (
            <Button
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const { acceptInviteAction } = await import("../../actions");
                  const res = await acceptInviteAction(token);
                  if (notify(res, t("acceptFailed"), t("joinedToast"))) setDone(true);
                })
              }
            >
              {pending && <Loader2Icon className="animate-spin" />}
              {t("accept")}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
