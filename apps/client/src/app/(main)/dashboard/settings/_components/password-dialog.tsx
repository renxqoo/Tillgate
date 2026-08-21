"use client";

import { useState } from "react";

import { KeyRoundIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@ai-gateway/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@ai-gateway/ui/components/ui/dialog";

import { PasswordForm } from "./password-form";

/** 「修改密码」弹窗：设置页安全卡片入口 */
export function PasswordDialog() {
  const t = useTranslations("settings");
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <KeyRoundIcon className="size-4" />
          {t("changePassword")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("changePassword")}</DialogTitle>
          <DialogDescription>{t("changePasswordDesc")}</DialogDescription>
        </DialogHeader>
        <PasswordForm onSuccess={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
