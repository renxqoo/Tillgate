/**
 * 简化版 nav-user 数据。原来的模板是 multi-account 切换（演示），我们这里只展示当前用户。
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
