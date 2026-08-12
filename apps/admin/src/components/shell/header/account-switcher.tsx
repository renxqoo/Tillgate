"use client";

import { useTransition } from "react";

import { Loader2Icon, LogOut } from "lucide-react";

import {
  Avatar,
  AvatarFallback,
} from "@ai-gateway/ui/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ai-gateway/ui/components/ui/dropdown-menu";
import { getInitials } from "@ai-gateway/ui/lib/utils";

export interface AccountSwitcherUser {
  readonly name: string;
  readonly email: string;
}

export function AccountSwitcher({ user }: { readonly user: AccountSwitcherUser }) {
  const [pending, startTransition] = useTransition();

  async function handleLogout() {
    startTransition(async () => {
      const { logoutAction } = await import("@/lib/server-actions/auth");
      await logoutAction();
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="账号菜单"
        className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Avatar className="size-8 rounded-lg">
          <AvatarFallback className="rounded-lg">{getInitials(user.name)}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-56 rounded-lg" side="bottom" align="end" sideOffset={4}>
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium leading-none">{user.name}</p>
            <p className="text-xs leading-none text-muted-foreground">{user.email}</p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={handleLogout}
          disabled={pending}
          className="cursor-pointer text-destructive focus:text-destructive"
        >
          {pending ? <Loader2Icon className="animate-spin" /> : <LogOut />}
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
