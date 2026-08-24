'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@tillgate/ui';
import { useEffect, useState, useTransition } from 'react';
import type { ReactNode } from 'react';
import { Loader2Icon, Maximize2Icon, Minimize2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { fetchTraceDetail, fetchTraceDetailByRequestId } from '@/server/tracing-actions';
import type { TraceDetailDto as TraceDetail } from '@tillgate/api-client';
import { TraceGraph } from './trace-graph';
import { TraceWaterfall } from './trace-waterfall';

/**
 * trace 详情弹窗：点击列表里的 traceId / request_id 打开，懒加载详情；
 * 路线图/瀑布双 tab；右上角全屏切换（图内容组件与内联卡共用，单一展示真相）。
 * traceId 与 requestId 二选一：requestId 变体走 by-request 关联（计费复核入口）。
 */
export function TraceDetailDialog({
  traceId,
  requestId,
  rootName,
  defaultOpen = false,
  hideTrigger = false,
}: {
  traceId?: string;
  requestId?: string;
  rootName?: string;
  /** 落地带 requestId 深链（计费复核「查链路」）时自动打开 */
  defaultOpen?: boolean;
  /** 深链自动打开实例不渲染 trigger（列表行内已有点击入口） */
  hideTrigger?: boolean;
}) {
  if (Boolean(traceId) === Boolean(requestId)) {
    throw new Error('TraceDetailDialog requires exactly one of traceId or requestId');
  }
  const t = useTranslations('tracing');
  const subjectId = traceId ?? requestId ?? '';
  const [open, setOpen] = useState(defaultOpen);
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [view, setView] = useState<'graph' | 'waterfall'>('graph');
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open || detail || error) return;
    startTransition(async () => {
      const result = traceId
        ? await fetchTraceDetail(traceId)
        : await fetchTraceDetailByRequestId(requestId!);
      if ('error' in result) {
        setError(result.error);
      } else if (result.spans.length === 0) {
        setError(t('noSpans'));
      } else {
        setDetail(result);
      }
    });
  }, [open, detail, error, traceId, requestId]);

  let detailContent: ReactNode = null;
  if (pending) {
    detailContent = (
      <div className="flex h-[420px] items-center justify-center text-muted-foreground">
        <Loader2Icon className="mr-2 animate-spin" /> {t('loading')}
      </div>
    );
  } else if (error) {
    detailContent = <p className="py-10 text-center text-sm text-destructive">{error}</p>;
  } else if (detail && view === 'graph') {
    detailContent = (
      <TraceGraph
        spans={detail.spans}
        totalMs={detail.durationMs}
        heightClass={fullscreen ? 'h-[calc(100vh-10rem)]' : 'h-[420px]'}
      />
    );
  } else if (detail) {
    detailContent = (
      <TraceWaterfall
        spans={detail.spans}
        startMs={detail.startMs}
        totalMs={detail.durationMs}
        heightClass={fullscreen ? 'h-[calc(100vh-10rem)]' : 'max-h-[60vh]'}
      />
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          // 关闭复位，下次打开重新加载/回到默认视图
          setDetail(null);
          setError(null);
          setFullscreen(false);
          setView('graph');
        }
      }}
    >
      {hideTrigger ? null : (
        <DialogTrigger
          render={
            <button
              type="button"
              className="font-mono text-xs text-primary underline underline-offset-2"
              title={traceId ? t('viewGraph') : t('viewTrace')}
            >
              {subjectId.slice(0, 12)}…
            </button>
          }
        />
      )}
      <DialogContent
        className={
          fullscreen
            ? 'left-0 top-0 h-screen w-screen max-w-none translate-x-0 translate-y-0 rounded-none p-4 sm:max-w-none'
            : // 基类含 sm:max-w-md（448px），必须显式清掉，w-[80vw] 才能生效
              'w-[80vw] max-w-none overflow-hidden sm:max-w-none'
        }
      >
        <DialogHeader className="flex-row items-center gap-3 space-y-0 pr-12">
          <DialogTitle className="flex items-center gap-2 text-base">
            <code className="font-mono text-sm">{subjectId.slice(0, 16)}…</code>
            {rootName ? (
              <span className="max-w-72 truncate text-sm font-normal text-muted-foreground">
                {rootName}
              </span>
            ) : null}
          </DialogTitle>
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setView(view === 'graph' ? 'waterfall' : 'graph')}
              className="text-xs"
            >
              {view === 'graph' ? t('waterfall') : t('graph')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setFullscreen(!fullscreen)}
              title={fullscreen ? t('exitFullscreen') : t('fullscreen')}
            >
              {fullscreen ? <Minimize2Icon /> : <Maximize2Icon />}
            </Button>
          </div>
        </DialogHeader>
        <DialogDescription render={<div className="sr-only">{t('srDetail')}</div>} />
        <div className="min-h-0 overflow-hidden">{detailContent}</div>
      </DialogContent>
    </Dialog>
  );
}
