'use client';

// 授权树勾选件（page+button;勾按钮自动勾页面 read 由消费方回调实现）

import type { PermissionNode } from '@tillgate/api-client';
import { Checkbox } from '@tillgate/ui';
import { useTranslations } from 'next-intl';

/** 授权树勾选（page+button;勾按钮自动勾页面 read——纯 UI 便利非后端不变量） */
export function GrantTree({
  nodes,
  selected,
  onToggle,
}: {
  nodes: PermissionNode[];
  selected: Set<string>;
  onToggle: (code: string, next: boolean) => void;
}) {
  const t = useTranslations('permissions');
  const tShared = useTranslations('common');
  const groups = nodes
    .filter((n) => n.type === 'group')
    .toSorted((a, b) => a.sortOrder - b.sortOrder);
  const pages = nodes.filter((n) => n.type === 'page');
  const buttons = nodes.filter((n) => n.type === 'button');

  return (
    <div className="max-h-80 space-y-3 overflow-y-auto rounded-md border p-3">
      {groups.map((group) => {
        const groupPages = pages
          .filter((page) => page.parentId === group.id)
          .toSorted((a, b) => a.sortOrder - b.sortOrder);
        if (groupPages.length === 0) return null;
        return (
          <div key={group.id} className="space-y-1.5">
            <div className="text-xs font-semibold text-muted-foreground">{group.name}</div>
            {groupPages.map((page) => {
              const pageButtons = buttons
                .filter((button) => button.parentId === page.id)
                .toSorted((a, b) => a.sortOrder - b.sortOrder);
              // 提前收窄 code：闭包内属性收窄会失效（no-non-null-assertion 修复）
              const pageCode = page.code;
              return (
                <div key={page.id} className="space-y-1 rounded-md bg-muted/40 px-2.5 py-2">
                  {pageCode != null ? (
                    <label
                      className={`flex items-center gap-2 text-sm font-medium${page.status === 1 ? ' opacity-50' : ''}`}
                    >
                      <Checkbox
                        checked={selected.has(pageCode)}
                        disabled={page.status === 1}
                        onCheckedChange={(checked) => onToggle(pageCode, checked === true)}
                      />
                      {page.name}
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {pageCode}
                      </span>
                      {page.status === 1 ? (
                        <span className="text-[10px] text-muted-foreground">
                          （{tShared('disabled')}）
                        </span>
                      ) : null}
                    </label>
                  ) : (
                    <div className="text-sm font-medium">{page.name}</div>
                  )}
                  {pageButtons.length > 0 && (
                    <div className="ml-6 flex flex-col gap-1">
                      {pageButtons.map((button) => (
                        <label
                          key={button.id}
                          className={`flex items-center gap-2 text-sm${button.status === 1 ? ' opacity-50' : ''}`}
                        >
                          <Checkbox
                            checked={selected.has(button.code ?? '')}
                            disabled={button.status === 1}
                            onCheckedChange={(checked) =>
                              onToggle(button.code ?? '', checked === true)
                            }
                          />
                          {button.name}
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {button.code}
                          </span>
                          {button.status === 1 ? (
                            <span className="text-[10px] text-muted-foreground">
                              （{tShared('disabled')}）
                            </span>
                          ) : null}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      {groups.length === 0 && <div className="text-sm text-muted-foreground">{t('empty')}</div>}
    </div>
  );
}
