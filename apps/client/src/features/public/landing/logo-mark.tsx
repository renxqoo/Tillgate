import { Sparkles } from 'lucide-react';

/** 品牌星形标记 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center justify-center ${className ?? ''}`}>
      <Sparkles className="h-full w-full" aria-hidden />
    </span>
  );
}
