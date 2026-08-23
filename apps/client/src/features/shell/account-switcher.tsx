'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';

import { Loader2Icon, LogOut } from 'lucide-react';

import {
  Avatar,
  AvatarFallback,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@tokenlens/ui';

import { getInitials } from '@/features/shared/initials';

export function AccountSwitcher({
  user,
  onLogout,
}: {
  user: { name: string; email: string };
  /** 退出登录（由 app 注入各自的 logout server action） */
  onLogout: () => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const t = useTranslations('ui');

  function handleLogout() {
    startTransition(async () => {
      await onLogout();
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('accountMenu')}
        className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Avatar className="size-8 rounded-lg">
          <AvatarFallback className="rounded-lg">{getInitials(user.name)}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-56 rounded-lg" side="bottom" align="end" sideOffset={4}>
        <DropdownMenuGroup>
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col space-y-1">
              <p className="text-sm font-medium leading-none">{user.name}</p>
              <p className="text-xs leading-none text-muted-foreground">{user.email}</p>
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={handleLogout}
          disabled={pending}
          className="cursor-pointer text-destructive focus:text-destructive"
        >
          {pending ? <Loader2Icon className="animate-spin" /> : <LogOut />}
          {t('logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
