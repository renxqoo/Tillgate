"use client";

import { useState } from "react";

import { KeyRoundIcon } from "lucide-react";

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
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <KeyRoundIcon className="size-4" />
          修改密码
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>修改密码</DialogTitle>
          <DialogDescription>更新您的登录密码，保存后下次登录生效</DialogDescription>
        </DialogHeader>
        <PasswordForm onSuccess={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
