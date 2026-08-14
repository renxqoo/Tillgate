'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2Icon, StoreIcon, TriangleAlertIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@ai-gateway/ui/components/ui/button';
import { Checkbox } from '@ai-gateway/ui/components/ui/checkbox';
import { Input } from '@ai-gateway/ui/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ai-gateway/ui/components/ui/table';
import { Badge } from '@ai-gateway/ui/components/ui/badge';
import { importCatalogAction } from '../actions';

/**
 * 模型目录（OpenRouter 免费模型一键入库）：
 * 勾选 → 对外名（默认清洗建议，可改）→ 价格（默认平台价，提交即确认）→ 导入。
 * 漂移标红：上游目录价 > 0 而我们的卖价 = 0 → 亏钱风险，提示更新或下架。
 */

export interface CatalogItem {
  realModel: string;
  displayName: string;
  contextLength: number | null;
  catalogPromptUsd: string;
  catalogCompletionUsd: string;
  suggestedName: string;
  imported: {
    externalName: string;
    inputPrice: string;
    outputPrice: string;
  } | null;
  priceWarning: boolean;
}

interface Draft {
  selected: boolean;
  externalName: string;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  contextLength: string;
}

export function CatalogContent({
  items,
  fetchedAt,
  channelReady,
}: {
  items: CatalogItem[];
  fetchedAt: string;
  channelReady: boolean;
}) {
  const router = useRouter();
  const [apiKey, setApiKey] = useState('');
  const [query, setQuery] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.realModel.toLowerCase().includes(q) ||
        i.displayName.toLowerCase().includes(q) ||
        i.suggestedName.toLowerCase().includes(q),
    );
  }, [items, query]);

  function draftOf(item: CatalogItem): Draft {
    return (
      drafts[item.realModel] ?? {
        selected: false,
        externalName: item.suggestedName,
        inputPrice: '0',
        outputPrice: '0',
        cacheInputPrice: '0',
        contextLength:
          item.contextLength != null ? String(item.contextLength) : '',
      }
    );
  }

  const selectedItems = filtered.filter((i) => draftOf(i).selected);

  function toggle(item: CatalogItem, selected: boolean): void {
    const d = draftOf(item);
    setDrafts((prev) => ({ ...prev, [item.realModel]: { ...d, selected } }));
  }

  function patch(item: CatalogItem, patchValue: Partial<Draft>): void {
    const d = draftOf(item);
    setDrafts((prev) => ({ ...prev, [item.realModel]: { ...d, ...patchValue } }));
  }

  function doImport(): void {
    if (selectedItems.length === 0) return;
    if (!channelReady && apiKey.trim().length === 0) {
      toast.error('首次导入需要填写 OpenRouter 平台 API Key');
      return;
    }
    startTransition(async () => {
      const res = await importCatalogAction({
        ...(channelReady ? {} : { apiKey: apiKey.trim() }),
        models: selectedItems.map((i) => {
          const d = draftOf(i);
          return {
            externalName: d.externalName,
            realModel: i.realModel,
            inputPrice: Number(d.inputPrice) || 0,
            outputPrice: Number(d.outputPrice) || 0,
            cacheInputPrice: Number(d.cacheInputPrice) || 0,
            ...(d.contextLength.trim() !== '' && Number.isInteger(Number(d.contextLength))
              ? { contextLength: Number(d.contextLength) }
              : {}),
          };
        }),
      });
      if (res.error) toast.error(res.error);
      else {
        toast.success(`已导入 ${selectedItems.length} 个模型（价格按提交值生效）`);
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="搜索模型…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-56"
        />
        <span className="text-xs text-muted-foreground">
          目录抓取于 {new Date(fetchedAt).toLocaleString()} · 共 {items.length} 个免费模型
        </span>
        <div className="ml-auto flex items-center gap-2">
          {!channelReady ? (
            <Input
              type="password"
              placeholder="OpenRouter API Key（首次导入必填）"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="w-72"
            />
          ) : null}
          <Button disabled={pending || selectedItems.length === 0} onClick={doImport}>
            {pending ? <Loader2Icon className="mr-1 animate-spin" /> : <StoreIcon className="mr-1" />}
            导入选中（{selectedItems.length}）
          </Button>
        </div>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10"></TableHead>
              <TableHead>上游模型</TableHead>
              <TableHead className="w-44">对外名（可改）</TableHead>
              <TableHead className="w-24 text-right">输入价</TableHead>
              <TableHead className="w-24 text-right">输出价</TableHead>
              <TableHead className="w-24 text-right">缓存价</TableHead>
              <TableHead className="w-28 text-right">上下文</TableHead>
              <TableHead className="w-28">状态</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((item) => {
              const d = draftOf(item);
              const warned = item.priceWarning;
              return (
                <TableRow key={item.realModel} className={warned ? 'bg-destructive/5' : undefined}>
                  <TableCell>
                    <Checkbox
                      checked={d.selected}
                      onCheckedChange={(v) => toggle(item, v === true)}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <code className="text-xs">{item.realModel}</code>
                      <span className="text-xs text-muted-foreground">{item.displayName}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Input
                      value={d.externalName}
                      onChange={(e) => patch(item, { externalName: e.target.value })}
                      className="h-8 text-xs"
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={d.inputPrice}
                      onChange={(e) => patch(item, { inputPrice: e.target.value })}
                      className="h-8 text-right text-xs tabular-nums"
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={d.outputPrice}
                      onChange={(e) => patch(item, { outputPrice: e.target.value })}
                      className="h-8 text-right text-xs tabular-nums"
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={d.cacheInputPrice}
                      onChange={(e) => patch(item, { cacheInputPrice: e.target.value })}
                      className="h-8 text-right text-xs tabular-nums"
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={d.contextLength}
                      placeholder="—"
                      onChange={(e) => patch(item, { contextLength: e.target.value })}
                      className="h-8 text-right text-xs tabular-nums"
                      title="上下文窗口（token），默认取目录值"
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {item.imported ? (
                        <Badge variant="outline">已导入 {item.imported.externalName}</Badge>
                      ) : null}
                      {warned ? (
                        <Badge variant="destructive" className="gap-1">
                          <TriangleAlertIcon className="size-3" />
                          上游已收费
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        价格单位为 元/百万 token，默认预填平台价（免费模型为 0），提交即确认为你的卖价；
        渠道限流预填 20 RPM，渠道名 free-openrouter。导入后到「模型映射」点烧瓶图标逐渠道测试。
      </p>
    </div>
  );
}
