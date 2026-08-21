/**
 * 简化版 nav-user 数据：只展示当前用户（不做多账号切换）。
 * 实际值来自 Server Component 读 /api/me。
 */
export interface AppUser {
  readonly name: string;
  readonly email: string;
  readonly avatar: string;
}

/** Placeholder fallback before session is known — Layout uses 'me' directly. */
export const PLACEHOLDER_USER: AppUser = {
  name: "Loading…",
  email: "",
  avatar: "",
};
