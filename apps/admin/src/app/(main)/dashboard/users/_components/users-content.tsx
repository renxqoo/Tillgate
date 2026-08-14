'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';

import {
  BanknoteIcon,
  EyeIcon,
  GiftIcon,
  KeyRoundIcon,
  Loader2Icon,
  PencilIcon,
  ScaleIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@ai-gateway/ui/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@ai-gateway/ui/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ai-gateway/ui/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ai-gateway/ui/components/ui/table';
import { formatMoney } from '@ai-gateway/api-client/formatters';

import { AdjustDialog, GiftDialog, PasswordDialog } from './user-dialogs';
import type { RateCardOption, UserRow } from '../types';

export function UsersContent({
  users,
  initialQuery: _initialQuery,
  rateCards,
}: {
  readonly users: ReadonlyArray<UserRow>;
  readonly initialQuery: string;
  readonly rateCards: ReadonlyArray<RateCardOption>;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-16">ID</TableHead>
          <TableHead>账号</TableHead>
          <TableHead>显示名</TableHead>
          <TableHead>邮箱</TableHead>
          <TableHead className="w-20">状态</TableHead>
          <TableHead>费率卡</TableHead>
          <TableHead className="text-right">已结算</TableHead>
          <TableHead className="text-right">处理中预留</TableHead>
          <TableHead className="text-right">可用额度</TableHead>
          <TableHead className="text-right">透支上限</TableHead>
          <TableHead className="text-right">每日花费上限</TableHead>
          <TableHead className="w-44">最近登录</TableHead>
          <TableHead className="w-40 text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.length === 0 ? (
          <TableRow>
            <TableCell colSpan={13} className="h-24 text-center text-muted-foreground">
              无匹配用户
            </TableCell>
          </TableRow>
        ) : (
          users.map((u) => <UserRowItem key={u.id} user={u} rateCards={rateCards} />)
        )}
      </TableBody>
    </Table>
  );
}

function UserRowItem({
  user,
  rateCards,
}: {
  user: UserRow;
  rateCards: ReadonlyArray<RateCardOption>;
}) {
  const [pending, setPending] = useState(false);

  async function toggleStatus() {
    const newStatus = user.status === 0 ? 1 : 0;
    const action = newStatus === 1 ? '封禁' : '解封';
    const freezeReason = newStatus === 1 ? (prompt(`请输入${action}原因（可选）`) ?? '') : '';
    if (newStatus === 1 && !confirm(`确定${action}用户 ${user.subject}？`)) return;
    setPending(true);
    const { setUserStatusAction } = await import('../actions');
    const res = await setUserStatusAction(user.id, {
      status: newStatus,
      freezeReason: newStatus === 1 ? freezeReason : '',
    });
    setPending(false);
    if (res.error) toast.error(`${action}失败`, { description: res.error });
    else toast.success(`已${action}`);
  }

  return (
    <TableRow>
      <TableCell className="text-xs text-muted-foreground tabular-nums">
        <Link href={`/dashboard/users/${user.id}`} className="hover:underline">
          #{user.id}
        </Link>
      </TableCell>
      <TableCell className="font-medium">
        <Link href={`/dashboard/users/${user.id}`} className="hover:underline">
          {user.subject}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground">{user.displayName ?? '—'}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{user.email ?? '—'}</TableCell>
      <TableCell>
        {user.status === 0 ? (
          <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
            正常
          </span>
        ) : (
          <span
            title={user.freezeReason ?? undefined}
            className="inline-flex items-center rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive"
          >
            已封禁
          </span>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{user.rateCardName ?? '—'}</TableCell>
      <TableCell className="text-right font-medium tabular-nums">
        {formatMoney(user.balance)}
      </TableCell>
      <TableCell className="text-right tabular-nums text-amber-600">
        {formatMoney(user.reservedBalance)}
      </TableCell>
      <TableCell className="text-right font-medium tabular-nums">
        {formatMoney(user.availableBalance)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatMoney(user.creditLimit)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {user.dailySpendLimit === null ? '不限' : formatMoney(user.dailySpendLimit)}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString('zh-CN') : '从未'}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <AdjustDialog
            user={user}
            trigger={
              <Button size="sm" variant="ghost" title="调账">
                <ScaleIcon />
              </Button>
            }
          />
          <GiftDialog
            user={user}
            trigger={
              <Button size="sm" variant="ghost" title="赠送">
                <GiftIcon />
              </Button>
            }
          />
          <PasswordDialog
            user={user}
            trigger={
              <Button size="sm" variant="ghost" title="设置密码">
                <KeyRoundIcon />
              </Button>
            }
          />
          <BindRateCardDialog user={user} rateCards={rateCards} />
          <Button
            size="sm"
            variant="ghost"
            title="详情"
            onClick={() => {
              window.location.href = `/dashboard/users/${user.id}`;
            }}
          >
            <EyeIcon />
          </Button>
          <Button
            size="sm"
            variant={user.status === 0 ? 'destructive' : 'outline'}
            disabled={pending}
            onClick={toggleStatus}
          >
            {pending ? (
              <Loader2Icon className="animate-spin" />
            ) : user.status === 0 ? (
              <ShieldOffIcon />
            ) : (
              <ShieldCheckIcon />
            )}
            {user.status === 0 ? '封禁' : '解封'}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function BindRateCardDialog({
  user,
  rateCards,
}: {
  user: UserRow;
  rateCards: ReadonlyArray<RateCardOption>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState<string>(
    user.rateCardId === null ? 'none' : String(user.rateCardId),
  );

  function onSubmit() {
    startTransition(async () => {
      const targetId = value === 'none' ? null : Number(value);
      const { bindRateCardAction } = await import('../actions');
      const res = await bindRateCardAction(user.id, targetId);
      if (res.error) {
        toast.error('绑定失败', { description: res.error });
        return;
      }
      toast.success('已更新费率卡');
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title="绑定费率卡">
          <BanknoteIcon />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PencilIcon /> 绑定费率卡 - {user.subject}
          </DialogTitle>
          <DialogDescription>选择一张费率卡，或解绑</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="选择费率卡" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">（解绑）</SelectItem>
              {rateCards.map((r) => (
                <SelectItem key={r.id} value={String(r.id)}>
                  {r.name}（×{r.coefficient}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button disabled={pending} onClick={onSubmit}>
            {pending && <Loader2Icon className="animate-spin" />}确认
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
