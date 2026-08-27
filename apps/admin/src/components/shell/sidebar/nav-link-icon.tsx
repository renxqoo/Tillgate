'use client';

import type { NavLinkIconProps } from './nav-shared';
import { CollapsedIconFallback } from './collapsed-icon-fallback';

export function NavLinkIcon({ item, showFallback }: NavLinkIconProps) {
  const Icon = item.icon;

  if (Icon) {
    return <Icon />;
  }

  if (showFallback) {
    return <CollapsedIconFallback title={item.title} />;
  }

  return null;
}
