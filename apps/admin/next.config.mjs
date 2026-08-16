/** @type {import('next').NextConfig} */

/**
 * 浏览器安全头（两个面板同款；API 面由各自 hono app 的 securityHeaders 覆盖）。
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

const nextConfig = {
  output: 'standalone',
  // dev 源站白名单：LAN TLS 前门（docker/nginx/nginx.dev-tls.conf，见 README-dev-tls.md）
  // 经 https://<IP>:344x 反代访问 dev server 时，浏览器 origin 与 dev server 自知
  // host 不同，Next 16 dev 会拒绝 HMR/水合——只影响开发模式，生产构建忽略此配置
  // 裸主机名 + 端口变体都列上（Next 按请求提取的 host:port 归一匹配）
  allowedDevOrigins: [
    '192.168.31.98',
    '192.168.31.98:3443',
    '192.168.31.98:3444',
    'localhost',
    'localhost:3443',
    'localhost:3444',
  ],
  // development 条件解析到 src 的 workspace 包必须列在此（Next 才做 .js→.ts 扩展名映射）；
  // providers 页直接引 @ai-gateway/ai 的 SUPPORTED_PROTOCOLS（2026-08-16 Module not found 修复）
  transpilePackages: [
    '@ai-gateway/ui',
    '@ai-gateway/api-client',
    '@ai-gateway/tracing',
    '@ai-gateway/ai',
  ],
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

export default nextConfig;
