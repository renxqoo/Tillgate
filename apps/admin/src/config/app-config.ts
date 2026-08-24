import packageJson from '../../package.json';

const currentYear = new Date().getFullYear();

export const APP_CONFIG = {
  name: 'Tillgate',
  version: packageJson.version,
  copyright: `© ${currentYear}, Tillgate.`,
  meta: {
    title: 'Tillgate - Multi-provider LLM API Gateway',
    description:
      'Tillgate is a multi-provider LLM API gateway: OpenAI-compatible entry, channel routing and failover, wallet billing, subscriptions and quotas, end-to-end tracing.',
  },
};
