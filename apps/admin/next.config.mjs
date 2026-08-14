/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@ai-gateway/ui', '@ai-gateway/api-client', '@ai-gateway/tracing'],
  reactCompiler: true,
  experimental: {
    // 渠道入货表单需上传凭证截图（base64 ≤ 2MB），放宽 server action 请求体上限
    serverActions: { bodySizeLimit: '5mb' },
  },
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production',
  },
};

export default nextConfig;
