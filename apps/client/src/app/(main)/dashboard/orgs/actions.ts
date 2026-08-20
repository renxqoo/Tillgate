"use server";

import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@ai-gateway/api-client";

export async function inviteMemberAction(
  orgId: number,
  email: string,
): Promise<{ error?: string; link?: string }> {
  if (!email.trim()) return { error: "请输入邮箱" };
  try {
    const res = await apiFetch<{ invitationId: number; token: string }>(`/v1/orgs/${orgId}/invitations`, {
      method: "POST",
      body: { email: email.trim() },
    });
    revalidatePath("/dashboard/orgs");
    return { link: `/dashboard/orgs/accept?token=${res.token}` };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "邀请失败" };
  }
}

export async function acceptInviteAction(token: string): Promise<{ error?: string }> {
  try {
    await apiFetch("/v1/orgs/invitations/accept", { method: "POST", body: { token } });
    revalidatePath("/dashboard/orgs");
    revalidatePath("/dashboard/keys");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "接受失败" };
  }
}

export async function setMemberQuotaAction(
  orgId: number,
  userId: number,
  input: { dailySpendLimit?: string | null; monthlyQuota?: string | null },
): Promise<{ error?: string }> {
  try {
    await apiFetch(`/v1/orgs/${orgId}/members/${userId}`, { method: "PATCH", body: input });
    revalidatePath("/dashboard/orgs");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "保存失败" };
  }
}

export async function revokeInvitationAction(orgId: number, invitationId: number): Promise<{ error?: string }> {
  try {
    await apiFetch(`/v1/orgs/${orgId}/invitations/${invitationId}/revoke`, { method: "POST" });
    revalidatePath("/dashboard/orgs");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "撤销失败" };
  }
}

export async function removeMemberAction(orgId: number, userId: number): Promise<{ error?: string }> {
  try {
    await apiFetch(`/v1/orgs/${orgId}/members/${userId}`, { method: "DELETE" });
    revalidatePath("/dashboard/orgs");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "移除失败" };
  }
}
