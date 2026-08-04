import Link from 'next/link';
import { logoutAction } from '@/app/actions';
import { liToYuan } from '@/lib/api-client';

/**
 * 站点顶栏：Logo + 用户信息 + 注销。
 * 显示当前余额（厘→元）、角色徽章。
 */
export function SiteHeader({ me }: { me: { subject: string; balance: number; role: number; displayName: string | null } | null }) {
  return (
    <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="text-lg">🚪</span>
          <span>AI Gateway</span>
        </Link>
        {me ? (
          <div className="flex items-center gap-4 text-sm">
            <span className="text-muted-foreground">
              {me.displayName ?? me.subject}
              {me.role === 1 && <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">管理员</span>}
            </span>
            <span className="font-mono">¥{liToYuan(me.balance ?? 0)}</span>
            <form action={logoutAction}>
              <button type="submit" className="text-muted-foreground hover:text-foreground">
                注销
              </button>
            </form>
          </div>
        ) : (
          <Link href="/login" className="text-sm text-primary hover:underline">
            登录
          </Link>
        )}
      </div>
    </header>
  );
}
