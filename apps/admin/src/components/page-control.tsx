import { Button, PaginationLink } from '@tillgate/ui';

/** 单个页码控件：受控模式渲染 button，URL 模式渲染链接 */
export function PageControl({
  target,
  current,
  reachable,
  href,
  onPageChange,
  label,
}: {
  target: number;
  current: number;
  reachable: boolean;
  href: string;
  onPageChange?: (page: number) => void;
  label: string;
}) {
  return onPageChange ? (
    <Button
      type="button"
      variant={target === current ? 'outline' : 'ghost'}
      size="icon"
      onClick={() => reachable && onPageChange(target)}
      aria-current={target === current ? 'page' : undefined}
      aria-label={label}
      disabled={target === current}
    >
      {target}
    </Button>
  ) : (
    <PaginationLink href={href} isActive={target === current} aria-label={label}>
      {target}
    </PaginationLink>
  );
}
