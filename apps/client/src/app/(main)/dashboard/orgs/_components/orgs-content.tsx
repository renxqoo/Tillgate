"use client";

import { useState, useTransition } from "react";

import { Building2, CopyIcon, Loader2Icon, Trash2Icon, UserPlusIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@ai-gateway/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ai-gateway/ui/components/ui/card";
import { Input } from "@ai-gateway/ui/components/ui/input";

import type { OrgInvitationSummary, OrgMemberRow, OrgRow } from "@ai-gateway/api-client/types";
import { useActionResult } from "@ai-gateway/ui/components/action-toast";
import { ConfirmAction } from "@ai-gateway/ui/components/confirm-action";

export interface OrgWithMembers {
  org: OrgRow;
  members: OrgMemberRow[];
  invitations: OrgInvitationSummary[];
}

function fmt(v: string | null): string {
  return v === null || v === "" ? "不限" : `${v} 元`;
}

function parseNullableNumber(v: string): number | null {
  return v.trim() === "" ? null : Number(v);
}

export function OrgsContent({ orgs }: { readonly orgs: ReadonlyArray<OrgWithMembers> }) {
  return (
    <div className="flex flex-col gap-4">
      {orgs.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            尚未加入任何组织。企业购买团队套餐后会自动创建组织，或被邀请后加入。
          </CardContent>
        </Card>
      ) : (
        orgs.map(({ org, members, invitations }) => (
          <OrgCard key={org.id} org={org} members={members} invitations={invitations} />
        ))
      )}
    </div>
  );
}

function OrgCard({ org, members, invitations }: OrgWithMembers) {
  const isOwner = org.role === "owner";
  const active = members.filter((m) => m.status === 0);
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Building2 className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">{org.name}</CardTitle>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {isOwner ? "owner" : "成员"}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            订阅：{org.subscriptionName ?? "无"} · 成员 {active.length} 人
          </div>
        </div>
        <CardDescription>
          {isOwner ? "邀请成员、设置用量限额（席位=成员数，成员各自建自己的 Key）" : "你已加入该组织，可在 API Key 页选择此套餐计费"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isOwner ? <InviteForm org={org} /> : null}
        <MemberList org={org} members={active} isOwner={isOwner} />
        {isOwner ? <PendingInvitations org={org} invitations={invitations} /> : null}
      </CardContent>
    </Card>
  );
}

function InviteForm({ org }: { org: OrgRow }) {
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();

  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="text-sm font-medium flex items-center gap-1.5">
        <UserPlusIcon className="size-4" /> 邀请成员
      </div>
      {link ? (
        <div className="flex items-center gap-2 text-xs">
          <code className="flex-1 truncate rounded bg-muted px-2 py-1">{link}</code>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await navigator.clipboard.writeText(`${window.location.origin}${link}`);
              toast.success("邀请链接已复制");
            }}
          >
            <CopyIcon className="size-3" /> 复制链接
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="成员登录邮箱"
            className="flex-1"
          />
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const { inviteMemberAction } = await import("../actions");
                const res = await inviteMemberAction(org.id, email);
                if (notify(res, "邀请失败", "已生成邀请链接")) setLink(res.link ?? "");
              })
            }
          >
            {pending && <Loader2Icon className="animate-spin" />} 邀请
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        被邀请人须已注册且登录，且登录账号邮箱与邀请邮箱一致。
      </p>
    </div>
  );
}

function MemberList({ org, members, isOwner }: { org: OrgRow; members: OrgMemberRow[]; isOwner: boolean }) {
  return (
    <ul className="space-y-2">
      {members.length === 0 ? (
        <li className="text-sm text-muted-foreground">暂无成员</li>
      ) : (
        members.map((m) => (
          <li key={m.userId} className="flex items-center gap-2 rounded-md border p-2 text-sm">
            <span className="min-w-0 flex-1 truncate">{m.displayName || m.email || `#${m.userId}`}</span>
            <span className="text-xs text-muted-foreground">{m.role === "owner" ? "owner" : "成员"}</span>
            {isOwner && m.role !== "owner" ? (
              <>
                <QuotaEditor org={org} member={m} />
                <RemoveButton org={org} member={m} />
              </>
            ) : null}
          </li>
        ))
      )}
    </ul>
  );
}

function PendingInvitations({ org, invitations }: { org: OrgRow; invitations: OrgInvitationSummary[] }) {
  const notify = useActionResult();
  const [pending, startTransition] = useTransition();
  if (invitations.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">待接受邀请（{invitations.length}）</p>
      <ul className="space-y-1.5">
        {invitations.map((inv) => (
          <li key={inv.id} className="flex items-center gap-2 rounded-md border border-dashed p-2 text-sm">
            <span className="min-w-0 flex-1 truncate">{inv.email}</span>
            <span className="text-xs text-muted-foreground">
              {new Date(inv.expiresAt).toLocaleDateString()} 到期
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const { revokeInvitationAction } = await import("../actions");
                  const res = await revokeInvitationAction(org.id, inv.id);
                  notify(res, "撤销失败", "已撤销邀请");
                })
              }
            >
              <Trash2Icon className="size-4" /> 撤销
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function QuotaEditor({ org, member }: { org: OrgRow; member: OrgMemberRow }) {
  const [open, setOpen] = useState(false);
  const notify = useActionResult();
  const [daily, setDaily] = useState(member.dailySpendLimit ?? "");
  const [monthly, setMonthly] = useState(member.monthlyQuota ?? "");
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        日限 {fmt(member.dailySpendLimit)} · 配额 {fmt(member.monthlyQuota)}
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <Input
        value={daily}
        onChange={(e) => setDaily(e.target.value)}
        placeholder="日限(元)"
        className="h-8 w-24 text-xs"
      />
      <Input
        value={monthly}
        onChange={(e) => setMonthly(e.target.value)}
        placeholder="月配额(元)"
        className="h-8 w-24 text-xs"
      />
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const { setMemberQuotaAction } = await import("../actions");
            const res = await setMemberQuotaAction(org.id, member.userId, {
              dailySpendLimit: parseNullableNumber(daily),
              monthlyQuota: parseNullableNumber(monthly),
            });
            if (notify(res, "保存失败", "已保存")) setOpen(false);
          })
        }
      >
        {pending ? <Loader2Icon className="animate-spin" /> : "保存"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        取消
      </Button>
    </div>
  );
}

function RemoveButton({ org, member }: { org: OrgRow; member: OrgMemberRow }) {
  return (
    <ConfirmAction
      confirm={`确定移除成员 ${member.displayName || member.email}？其历史用量保留。`}
      action={async () => (await import("../actions")).removeMemberAction(org.id, member.userId)}
      errorTitle="移除失败"
      success="已移除"
    >
      {({ pending, onClick }) => (
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          disabled={pending}
          onClick={onClick}
        >
          {pending ? <Loader2Icon className="animate-spin" /> : <Trash2Icon className="size-4" />}
        </Button>
      )}
    </ConfirmAction>
  );
}
