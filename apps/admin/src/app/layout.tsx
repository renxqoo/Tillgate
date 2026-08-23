import { ThemeProvider, Toaster, TooltipProvider } from '@tokenlens/ui';
import type { ReactNode } from 'react';

import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';

import { DEFAULT_LOCALE, htmlLang, isLocale } from '@tokenlens/api-client/next';

import { getThemeBootCode } from '@/config/theme-boot';
import { APP_CONFIG } from '@/config/app-config';

import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return {
    title: {
      default: `${APP_CONFIG.name} — ${t('title')}`,
      template: `%s — ${APP_CONFIG.name}`,
    },
    description: t('description'),
  };
}

const bootCode = getThemeBootCode();

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const locale = await getLocale();
  return (
    <html
      lang={htmlLang(isLocale(locale) ? locale : DEFAULT_LOCALE)}
      suppressHydrationWarning
    >
      <head>
        {/* 水合前读 localStorage(theme) 落 dark class——与 ui ThemeProvider 同 key（防 FOUC） */}
        <script dangerouslySetInnerHTML={{ __html: bootCode }} />
      </head>
      <body className="min-h-screen antialiased" suppressHydrationWarning>
        <ThemeProvider>
          <TooltipProvider>
            <NextIntlClientProvider>
              {children}
              <Toaster />
            </NextIntlClientProvider>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
