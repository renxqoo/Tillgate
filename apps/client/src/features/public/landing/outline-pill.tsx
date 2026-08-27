import Link from 'next/link';

export function OutlinePill({
  href,
  children,
  className = '',
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-6 py-3 text-sm font-medium text-slate-700 transition-colors hover:border-slate-300 hover:text-slate-900 ${className}`}
    >
      {children}
    </Link>
  );
}
