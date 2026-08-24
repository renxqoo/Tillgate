import createNextIntlPlugin from 'next-intl/plugin';

/** @type {import('next').NextConfig} */

/**
 * 浏览器安全头（v1 同款；API 面由 admin-api hono app 的 securityHeaders 覆盖）。
 * CSP 为保守版：Next.js 水合需要内联脚本与样式，故 script/style 留 'unsafe-inline'；
 * frame-ancestors 'none' + X-Frame-Options DENY 防点击劫持（管理面板不允许被嵌入）。
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
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
];

// 局域网 IP 直访 dev server 时，Turbopack chunk 走 ES module（CORS 模式，必带 Origin 头），
// 而 Next 16 默认只放行 localhost（block-cross-site-dev）——非 localhost Origin 的 /_next/*
// 一律 403 Unauthorized。这里加白本机 LAN IP（仅 dev 生效）；IP 变化时可用
// NEXT_ALLOWED_DEV_ORIGINS 覆盖（逗号分隔），无需改代码。与 apps/client 同款。
const allowedDevOrigins = (process.env.NEXT_ALLOWED_DEV_ORIGINS ?? '192.168.31.98')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig = {
  output: 'standalone',
  allowedDevOrigins,
  // development 条件解析到 src 的 workspace 包必须列在此（Next 才做 .js→.ts 扩展名映射）
  transpilePackages: ['@tillgate/ui', '@tillgate/api-client'],
  reactCompiler: true,
  experimental: {
    // 渠道入货表单需上传凭证截图（base64 ≤ 2MB），放宽 server action 请求体上限
    serverActions: { bodySizeLimit: '5mb' },
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production',
  },
};

// next-intl 插件：默认加载 ./src/config/i18n-request.ts（无路由模式，语言走 cookie）
export default createNextIntlPlugin('./src/config/i18n-request.ts')(nextConfig);
