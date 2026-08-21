"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Loader2Icon, UserRoundPenIcon } from "lucide-react";
import { toast } from "sonner";

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
          修改名称
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>修改显示名称</DialogTitle>
          <DialogDescription>显示在面板与侧边栏，1-32 个字符</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const res = await updateDisplayNameAction({ displayName: name });
              if (!notify(res, "修改失败")) return;
              toast.success("显示名称已更新", { description: res.displayName });
              setOpen(false);
              router.refresh();
            });
          }}
          className="space-y-4"
        >
          <Field>
            <FieldLabel htmlFor="display-name-input">显示名称</FieldLabel>
            <Input
              id="display-name-input"
              maxLength={32}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            <FieldDescription>{name.trim().length} / 32 字符</FieldDescription>
          </Field>
          <Button type="submit" disabled={pending || !name.trim()} className="w-full">
            {pending && <Loader2Icon className="animate-spin" />}
            保存
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
