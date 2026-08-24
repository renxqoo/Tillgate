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
// 一律 403 Unauthorized。这里加白本机 LAN IP（仅 dev 生效）；IP 变化时可用
// NEXT_ALLOWED_DEV_ORIGINS 覆盖（逗号分隔），无需改代码。
const allowedDevOrigins = (process.env.NEXT_ALLOWED_DEV_ORIGINS ?? '192.168.31.98')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig = {
  output: 'standalone',
  allowedDevOrigins,
  // workspace 源码包由 Next 直接编译（ui/api-client exports 指 src；v1 同款配方）
  transpilePackages: ['@tokenlens/ui', '@tokenlens/api-client'],
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
