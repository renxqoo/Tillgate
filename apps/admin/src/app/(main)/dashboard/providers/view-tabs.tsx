import Link from 'next/link';

/** 视图 tab：在册（缺省）/ 回收站（view=deleted）；Link 导航，样式与模型映射视图 tab 同款 */
export function ViewTabs({
  active,
  labels,
}: {
  active: 'active' | 'deleted';
  labels: { all: string; deleted: string };
}) {
  return (
    <span className="flex gap-1 text-xs">
      <Link
        href="/dashboard/providers"
        className={`rounded-md px-2 py-1 ${
          active === 'active'
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-muted-foreground hover:bg-muted/70'
        }`}
      >
        {labels.all}
      </Link>
      <Link
        href="/dashboard/providers?view=deleted"
        className={`rounded-md px-2 py-1 ${
          active === 'deleted'
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-muted-foreground hover:bg-muted/70'
        }`}
      >
        {labels.deleted}
      </Link>
    </span>
  );
}
