'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';

import {
  BanknoteIcon,
  BriefcaseIcon,
  EyeIcon,
  GiftIcon,
  KeyRoundIcon,
  Loader2Icon,
  PencilIcon,
  ScaleIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
  UserIcon,
} from 'lucide-react';

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
import { fmtDateTime, formatMoney } from '@ai-gateway/api-client/formatters';

import { AdjustDialog, GiftDialog, PasswordDialog } from './user-dialogs';
import type { RateCardOption, AdminUserRow } from '@ai-gateway/api-client/types';
import { useActionResult } from "@ai-gateway/ui/components/action-toast";
import { StatusPill } from "@ai-gateway/ui/components/status-pill";

export function UsersContent({
  users,
  rateCards,
}: {
  readonly users: ReadonlyArray<AdminUserRow>;
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
          <TableHead className="w-20">类型</TableHead>
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
            <TableCell colSpan={14} className="h-24 text-center text-muted-foreground">
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
  user: AdminUserRow;
  rateCards: ReadonlyArray<RateCardOption>;
}) {
  const notify = useActionResult();
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
    notify(res, `${action}失败`, `已${action}`);
  }

  async function toggleEnterprise() {
    setPending(true);
    const { setUserEnterpriseAction } = await import('../actions');
    const res = await setUserEnterpriseAction(user.id, !user.isEnterprise);
    setPending(false);
    notify(res, '操作失败', user.isEnterprise ? '已取消企业' : '已设为企业');
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
          <StatusPill tone="success" label="正常" />
        ) : (
          <StatusPill tone="danger" label="已封禁" title={user.freezeReason ?? undefined} />
        )}
      </TableCell>
      <TableCell>
        {user.isEnterprise ? (
          <StatusPill tone="accent">
            <BriefcaseIcon className="size-3" /> 企业
          </StatusPill>
        ) : (
          <StatusPill tone="neutral">
            <UserIcon className="size-3" /> 个人
          </StatusPill>
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
        {user.lastLoginAt ? fmtDateTime(user.lastLoginAt) : '从未'}
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
            title={user.isEnterprise ? '取消企业' : '设为企业'}
            disabled={pending}
            onClick={toggleEnterprise}
          >
            {user.isEnterprise ? <UserIcon /> : <BriefcaseIcon />}
          </Button>
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
  user: AdminUserRow;
  rateCards: ReadonlyArray<RateCardOption>;
}) {
  const notify = useActionResult();
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
      if (!notify(res, '绑定失败', '已更新费率卡')) return;
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
