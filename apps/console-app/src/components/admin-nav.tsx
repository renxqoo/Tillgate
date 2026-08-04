import Link from 'next/link';

/** 管理后台导航（各管理页共用） */
export function AdminNav({ active }: { active: string }) {
  const items = [
    { href: '/admin/stats', key: 'stats', label: '仪表盘' },
    { href: '/admin/users', key: 'users', label: '用户' },
    { href: '/admin/channels', key: 'channels', label: '渠道' },
    { href: '/admin/rate-cards', key: 'rate-cards', label: '费率卡' },
    { href: '/admin/redeem-batches', key: 'redeem-batches', label: '充值码' },
  ];
  return (
    <nav className="flex flex-wrap gap-2 text-sm">
      {items.map((it) => (
        <Link
          key={it.key}
          href={it.href}
          className={`rounded-md px-3 py-1.5 ${active === it.key ? 'bg-primary text-primary-foreground' : 'border hover:bg-muted'}`}
        >
          {it.label}
        </Link>
      ))}
    </nav>
  );
}
