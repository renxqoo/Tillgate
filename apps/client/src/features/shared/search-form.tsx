import { useTranslations } from 'next-intl';
import { SearchIcon, XIcon } from 'lucide-react';

import { Button, Input } from '@tillgate/ui';

/** 原生 GET 搜索表单（模块级组件：压平 ListPage 的分支复杂度；除 q/page 外的筛选以 hidden input 保留） */
export function SearchForm(props: {
  hiddenParams: Array<[string, string | string[] | undefined]>;
  searchPlaceholder: string;
  q?: string;
  clearSearchHref: string;
}) {
  const t = useTranslations('ui');
  const { hiddenParams, searchPlaceholder, q, clearSearchHref } = props;
  return (
    <form method="GET" className="flex w-full min-w-0 items-center gap-2 sm:max-w-lg">
      {hiddenParams.map(([key, value]) =>
        Array.isArray(value) ? (
          value.map((v, i) => <input key={`${key}-${i}`} type="hidden" name={key} value={v} />)
        ) : (
          <input key={key} type="hidden" name={key} value={value ?? ''} />
        ),
      )}
      <div className="relative min-w-0 flex-1">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          name="q"
          defaultValue={q ?? ''}
          placeholder={searchPlaceholder}
          className="w-full pl-9"
        />
      </div>
      <Button type="submit" variant="outline">
        <SearchIcon data-icon="inline-start" />
        <span className="hidden sm:inline">{t('search')}</span>
      </Button>
      {q ? (
        <Button
          variant="ghost"
          size="icon"
          render={<a href={clearSearchHref} aria-label={t('clearSearch')} />}
        >
          <XIcon />
        </Button>
      ) : null}
    </form>
  );
}
