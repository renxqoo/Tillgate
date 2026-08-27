import { useTranslations } from 'next-intl';

import { GithubMarkIcon } from './github-mark-icon';
import { GoogleMarkIcon } from './google-mark-icon';
import type { OAuthOption } from './oauth-options';

/** 分隔线 + 第三方登录按钮组（无可用方式时不渲染） */
export function OAuthButtons({ options }: { options: OAuthOption[] }) {
  const t = useTranslations('auth');
  if (options.length === 0) return null;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        {t('or')}
        <span className="h-px flex-1 bg-border" />
      </div>
      {options.map((option) => (
        <a
          key={option.id}
          href={option.url}
          className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-input bg-background text-sm font-medium shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          {option.id === 'github' ? <GithubMarkIcon /> : <GoogleMarkIcon />}
          {t(option.label)}
        </a>
      ))}
    </div>
  );
}
