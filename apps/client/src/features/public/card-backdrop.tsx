'use client';

import type { CarouselCard } from './hero-carousel-shared';

/** 背景主题 */
export function CardBackdrop({ theme }: { theme: CarouselCard['theme'] }) {
  if (theme === 'models') {
    return (
      <div className="absolute inset-0 bg-gradient-to-br from-[#eef2ff] via-[#e6ebff] to-[#d8e0ff]" />
    );
  }
  if (theme === 'api') {
    return (
      <div className="absolute inset-0 bg-gradient-to-br from-[#111827] via-[#101726] to-[#0b1220]" />
    );
  }
  if (theme === 'usage') {
    return (
      <div className="absolute inset-0 bg-gradient-to-br from-[#f6f3ff] via-[#efe9ff] to-[#e4dbff]" />
    );
  }
  return (
    <div className="absolute inset-0 bg-gradient-to-br from-[#fff7ec] via-[#ffefdc] to-[#ffe3c2]" />
  );
}
