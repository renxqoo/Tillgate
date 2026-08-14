import { Hono } from 'hono';
import { clearRecentTraces, getRecentTraces, type ViewableTrace } from '@ai-gateway/core';

/**
 * 本地开发链路查看页（OTEL_TRACES_MODE=memory 专用，零基建）。
 *
 * 门控（挂载与鉴权都从严）：
 *   - 仅 memory 模式挂载（生产 otlp/off 模式下路由不存在 → 404）
 *   - DEBUG_TRACES_TOKEN 设置后必须带 ?token= 或 Authorization: Bearer
 *   - 未设置 token 时仅 NODE_ENV=development 放行
 * 数据：进程内环形缓冲（重启即失）；JSON 用 /debug/traces?format=json。
 */
export function debugTracesRoutes(options: { token?: string; dev: boolean }): Hono {
  const { token, dev } = options;
  return new Hono()
    .get('/traces', async (c) => {
      if (token) {
        const provided =
          c.req.query('token') ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
        if (provided !== token) return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
      } else if (!dev) {
        return c.json({ error: { code: 'NOT_FOUND' } }, 404);
      }

      if (c.req.query('clear') === 'true') {
        clearRecentTraces();
        return c.redirect('/debug/traces');
      }
      const traces = getRecentTraces(50);
      if (c.req.query('format') === 'json') return c.json({ traces });
      return c.html(renderHtml(traces));
    });
}

function renderHtml(traces: ViewableTrace[]): string {
  const rows = traces
    .map(
      (t) => `
      <tr>
        <td><code>${t.traceId.slice(0, 16)}…</code></td>
        <td>${escapeHtml(t.rootName)}</td>
        <td>${Math.round(t.durationMs)} ms</td>
        <td>${t.spanCount}</td>
        <td>${t.hasError ? '🔴' : '🟢'}</td>
        <td>${t.services.map(escapeHtml).join(', ')}</td>
      </tr>`,
    )
    .join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>本地 traces（内存缓冲）</title>
<style>
  body{font-family:system-ui,sans-serif;margin:24px;background:#0a0a0a;color:#ededed}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th,td{border:1px solid #262626;padding:6px 10px;text-align:left}
  th{background:#171717} code{color:#a5b4fc}
  a{color:#60a5fa}
</style></head><body>
<h2>本地 traces（进程内环形缓冲，重启即失）</h2>
<p><a href="?format=json">JSON</a> · <a href="?clear=true">清空</a> · 生产用 trace-receiver + 管理台「链路追踪」页</p>
<table><thead><tr><th>trace</th><th>入口</th><th>耗时</th><th>span</th><th>状态</th><th>服务</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">暂无数据：发几个请求后刷新（span 异步批量导出，稍等几秒）</td></tr>'}</tbody></table>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
