'use client';

import { useEffect, useState, useTransition } from 'react';
import { Loader2Icon, Maximize2Icon, Minimize2Icon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@ai-gateway/ui/components/ui/dialog';
import { Button } from '@ai-gateway/ui/components/ui/button';
import { fetchTraceDetail, type TraceDetail } from '../actions';
import { TraceGraph } from './trace-graph';
import { TraceWaterfall } from './trace-waterfall';

/**
 * trace 详情弹窗：点击列表里的 traceId 打开，懒加载详情；
 * 路线图/瀑布双 tab；右上角全屏切换（图内容组件与 inline 卡片共用，单一展示真相）。
 */
export function TraceDetailDialog({
  traceId,
  rootName,
}: {
  traceId: string;
  rootName: string;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [view, setView] = useState<'graph' | 'waterfall'>('graph');
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open || detail || error) return;
    startTransition(async () => {
      const result = await fetchTraceDetail(traceId);
      if ('error' in result) {
        setError(result.error);
      } else if (result.spans.length === 0) {
        setError('该 trace 无 span 数据');
      } else {
        setDetail(result);
      }
    });
  }, [open, detail, error, traceId]);

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
      <DialogTrigger asChild>
        <button
          type="button"
          className="font-mono text-xs text-primary underline underline-offset-2"
          title="点击查看链路路线图"
        >
          {traceId.slice(0, 12)}…
        </button>
      </DialogTrigger>
      <DialogContent
        className={
          fullscreen
            ? 'left-0 top-0 h-screen w-screen max-w-none translate-x-0 translate-y-0 rounded-none p-4 sm:max-w-none'
            : 'w-[96vw] max-w-5xl overflow-hidden'
        }
      >
        {/* pr-12：为右上角 absolute 关闭按钮（X，约 48px 宽区域）预留空间，两种模式下操作按钮都不被遮挡 */}
        <DialogHeader className="flex-row items-center gap-3 space-y-0 pr-12">
          <DialogTitle className="flex items-center gap-2 text-base">
            <code className="font-mono text-sm">{traceId.slice(0, 16)}…</code>
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
              {view === 'graph' ? '瀑布图（时序）' : '路线图（拓扑）'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setFullscreen(!fullscreen)}
              title={fullscreen ? '退出全屏' : '全屏'}
            >
              {fullscreen ? <Minimize2Icon /> : <Maximize2Icon />}
            </Button>
          </div>
        </DialogHeader>
        <DialogDescription asChild>
          <div className="sr-only">链路 trace 详情</div>
        </DialogDescription>
        <div className="min-h-0 overflow-hidden">
          {pending ? (
            <div className="flex h-[420px] items-center justify-center text-muted-foreground">
              <Loader2Icon className="mr-2 animate-spin" /> 加载 trace 详情…
            </div>
          ) : error ? (
            <p className="py-10 text-center text-sm text-destructive">{error}</p>
          ) : detail ? (
            view === 'graph' ? (
              <TraceGraph
                spans={detail.spans}
                totalMs={detail.durationMs}
                heightClass={fullscreen ? 'h-[calc(100vh-10rem)]' : 'h-[420px]'}
              />
            ) : (
              <TraceWaterfall
                spans={detail.spans}
                startMs={detail.startMs}
                totalMs={detail.durationMs}
                heightClass={fullscreen ? 'h-[calc(100vh-10rem)]' : 'max-h-[60vh]'}
              />
            )
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
