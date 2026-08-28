'use client';

import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

import { CardBackdrop } from './card-backdrop';
import { CardMock } from './card-mock';
import type { CarouselCard } from './hero-carousel-shared';

export function CardFace({ card }: { card: CarouselCard }) {
  return (
    <div className="relative mx-auto flex h-[400px] w-[min(880px,92vw)] flex-col overflow-hidden rounded-3xl md:h-[440px]">
      <CardBackdrop theme={card.theme} />
      <div className="relative z-10 p-8 md:p-10">
        <p className="text-[13px] font-medium text-slate-500">{card.eyebrow}</p>
        <h3 className="mt-3 text-2xl font-bold tracking-tight text-slate-900 md:text-3xl">
          {card.title}
        </h3>
        <p className="mt-2 max-w-[320px] text-[15px] leading-relaxed text-slate-500">{card.sub}</p>
      </div>
      <div className="absolute inset-x-0 bottom-8 hidden justify-end pr-10 md:flex">
        <CardMock card={card} />
      </div>
      <Link
        href={card.href}
        className="absolute right-6 bottom-6 z-20 flex items-center gap-1.5 rounded-full bg-slate-900/90 px-4 py-2 text-xs font-medium text-white shadow-lg transition-colors hover:bg-slate-900"
      >
        {card.title} <ChevronRight className="size-3.5" />
      </Link>
    </div>
  );
}
