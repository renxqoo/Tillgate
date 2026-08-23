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
      "frame-src https://challenges.cloudflare.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
];

const nextConfig = {
  output: 'standalone',
  // 操练场 BYOK 直连网关（同域推理端点）：生产由 nginx 分流（请求不达 Next，
  // 此规则不生效）；dev 无 nginx 时兜底转发本地网关。
  // ！！只转发推理端点——/v1/pricing 等属 client-api（server 侧走 CLIENT_API_BASE
  // 直连），通配整个 /v1 会劫持它们且网关未启动时全部 500（v1 曾发生，不重演）
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
