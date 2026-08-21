"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Loader2Icon, UserRoundPenIcon } from "lucide-react";
import { toast } from "sonner";
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
import { Field, FieldDescription, FieldLabel } from "@ai-gateway/ui/components/ui/field";
import { Input } from "@ai-gateway/ui/components/ui/input";

import { updateDisplayNameAction } from "../actions";
import { useActionResult } from "@ai-gateway/ui/components/action-toast";

/** 「修改显示名称」弹窗：设置页账户信息卡入口 */
export function DisplayNameDialog({ current }: { current: string }) {
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(current);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <UserRoundPenIcon className="size-4" />
          {t("editName")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("editNameTitle")}</DialogTitle>
          <DialogDescription>{t("editNameDesc")}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const res = await updateDisplayNameAction({ displayName: name });
              if (!notify(res, t("changeFailedRetry"))) return;
              toast.success(t("nameUpdatedToast"), { description: res.displayName });
              setOpen(false);
              router.refresh();
            });
          }}
          className="space-y-4"
        >
          <Field>
            <FieldLabel htmlFor="display-name-input">{t("displayName")}</FieldLabel>
            <Input
              id="display-name-input"
              maxLength={32}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            <FieldDescription>{t("charCount", { count: name.trim().length })}</FieldDescription>
          </Field>
          <Button type="submit" disabled={pending || !name.trim()} className="w-full">
            {pending && <Loader2Icon className="animate-spin" />}
            {tCommon("save")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
