import os from 'node:os';

import createNextIntlPlugin from 'next-intl/plugin';

/**
 * 浏览器安全头（API 面由各自 hono app 的 securityHeaders 覆盖）。
 * CSP 为保守版：Next.js 水合需要内联脚本与样式，故 script/style 留 'unsafe-inline'；
 * frame-ancestors 'none' + X-Frame-Options DENY 防点击劫持（面板不允许被嵌入）。
 * 注册页嵌 Cloudflare Turnstile（隐形人机验证），需放行其脚本与 iframe
 * （frame-src；缺省会回落 default-src 'self' 被拦）。
 */
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      'frame-src https://challenges.cloudflare.com',
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
];

// 局域网 IP 直访 dev server 时，Turbopack chunk 走 ES module（CORS 模式，必带 Origin 头），
// 而 Next 16 默认只放行 localhost（block-cross-site-dev）——非 localhost Origin 的 /_next/*
// 一律 403 Unauthorized（症状：页面能开但 JS 全挂、点击提交走原生表单整页刷新）。
// 白名单启动时动态枚举本机全部 IPv4（仅 dev 生效）：DHCP 换 IP / 换网络后无需改代码；
// NEXT_ALLOWED_DEV_ORIGINS（逗号分隔）保留为追加口（经代理域名访问 dev 等场景）。
const lanIps = Object.values(os.networkInterfaces())
  .flat()
  .filter((n) => n.family === 'IPv4' && !n.internal)
  .map((n) => n.address);

const allowedDevOrigins = [
  ...lanIps,
  ...(process.env.NEXT_ALLOWED_DEV_ORIGINS ?? '').split(',').map((s) => s.trim()),
].filter(Boolean);

const nextConfig = {
  output: 'standalone',
  // 不发 X-Powered-By: Next.js 响应头（技术栈指纹泄露）
  poweredByHeader: false,
  allowedDevOrigins,
  // workspace 源码包由 Next 直接编译（ui/api-client exports 指 src）
  transpilePackages: ['@tillgate/ui', '@tillgate/api-client'],
  logging: {
    // dev 下框架会把 Server Action 入参原样打进终端（登录表单的口令会明文出现，框架无脱敏），
    // 仅关 Server Function 调用日志这一路，普通请求日志（GET /xxx 200 in Xms）保留。与 apps/admin 同款。
    serverFunctions: false,
  },
  // 操练场 BYOK 直连网关（同域推理端点）：生产由 nginx 分流（请求不达 Next，
  // 此规则不生效）；dev 无 nginx 时兜底转发本地网关。
  // ！！只转发推理端点——/v1/pricing 等属 client-api（server 侧走 CLIENT_API_BASE
  // 直连），通配整个 /v1 会劫持它们且网关未启动时全部 500
  async rewrites() {
    const gateway = process.env.GATEWAY_BASE ?? 'http://localhost:8080';
    return [
      { source: '/v1/chat/completions', destination: `${gateway}/v1/chat/completions` },
      { source: '/v1/completions', destination: `${gateway}/v1/completions` },
      { source: '/v1/embeddings', destination: `${gateway}/v1/embeddings` },
      { source: '/v1/models', destination: `${gateway}/v1/models` },
    ];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

// next-intl 插件：默认加载 ./src/i18n/request.ts（无路由模式，语言走 cookie）
export default createNextIntlPlugin()(nextConfig);
