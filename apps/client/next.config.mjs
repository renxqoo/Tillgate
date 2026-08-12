/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@ai-gateway/ui', '@ai-gateway/api-client'],
};

export default nextConfig;