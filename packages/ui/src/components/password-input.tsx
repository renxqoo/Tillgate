"use client";

import { useState } from "react";

import { EyeIcon, EyeOffIcon, LockIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";

/**
 * 密码输入框 + 眼睛切换（收敛 4 处：admin 设置密码弹窗 / admin & client 登录 / client 注册）。
 *
 * - 默认：普通 Input + 右侧 ghost 眼睛按钮（admin 设置密码弹窗形态）。
 * - withLock：InputGroup + 锁形前缀 + 行尾眼睛（登录 / 注册表单形态），视觉与原实现一致。
 */
export function PasswordInput({
  className,
  withLock = false,
  ...props
}: React.ComponentProps<"input"> & { withLock?: boolean }) {
  const [show, setShow] = useState(false);

  if (!withLock) {
    return (
      <div className="relative">
        <Input
          type={show ? "text" : "password"}
          className={cn("pr-9", className)}
          {...props}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-1 top-1 size-7"
          onClick={() => setShow((s) => !s)}
          tabIndex={-1}
          aria-label={show ? "隐藏密码" : "显示密码"}
        >
          {show ? <EyeOffIcon /> : <EyeIcon />}
        </Button>
      </div>
    );
  }

  return (
    <InputGroup>
      <InputGroupAddon>
        <LockIcon />
      </InputGroupAddon>
      <InputGroupInput
        type={show ? "text" : "password"}
        {...props}
      />
      <InputGroupAddon align="inline-end">
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? "隐藏密码" : "显示密码"}
          className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
        >
          {show ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </InputGroupAddon>
    </InputGroup>
  );
}
