import { Card, CardContent, TabsContent } from '@tillgate/ui';
import type { getTranslations } from 'next-intl/server';
import type { AuditLogRow } from '@tillgate/api-client';

import { DataTable, type DataTableColumn } from '@/components/data-table';
import { Pager } from '@/components/pager';
import { PAGE_SIZE } from './detail-page-size';

/** 审计 Tab：审计表 + 独立分页（apage） */
export function AuditTab({
  auditLogs,
  auditTotal,
  auditPage,
  txPage,
  auditColumns,
  sortBy,
  order,
  t,
}: {
  auditLogs: AuditLogRow[];
  auditTotal: number;
  auditPage: number;
  txPage: number;
  auditColumns: DataTableColumn<AuditLogRow>[];
  sortBy: string | undefined;
  order: 'asc' | 'desc';
  t: Awaited<ReturnType<typeof getTranslations<'users'>>>;
}) {
  return (
    <TabsContent value="audit" className="w-full">
      <Card className="w-full ring-border/50">
        <CardContent className="px-0">
          <DataTable
            columns={auditColumns}
            rows={auditLogs}
            rowKey={(a) => a.id}
            sort={{ sortBy, order }}
            searchParams={{ apage: String(auditPage), tpage: String(txPage) }}
            empty={t('noAuditLogs')}
          />
          {auditTotal > PAGE_SIZE ? (
            <CardContent className="px-4 pb-4 pt-0">
              <Pager
                page={auditPage}
                totalPages={Math.max(1, Math.ceil(auditTotal / PAGE_SIZE))}
                total={auditTotal}
                pageKey="apage"
                searchParams={{
                  tpage: String(txPage),
                  sort_by: sortBy,
                  order: sortBy ? order : undefined,
                }}
              />
            </CardContent>
          ) : null}
        </CardContent>
      </Card>
    </TabsContent>
  );
}
