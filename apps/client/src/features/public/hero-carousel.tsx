'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { CardFace } from './card-face';

import type { CarouselCard } from './hero-carousel-shared';

export type { CarouselCard, CarouselModel, CarouselStat } from './hero-carousel-shared';

interface Props {
  cards: CarouselCard[];
  prevLabel: string;
  nextLabel: string;
}

export function HeroCarousel({ cards, prevLabel, nextLabel }: Props) {
  const [index, setIndex] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const total = cards.length;

  useEffect(() => {
    timer.current = setInterval(() => setIndex((i) => (i + 1) % total), 6000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [total]);

  const go = (dir: 1 | -1) => setIndex((i) => (i + dir + total) % total);

  return (
    <div className="relative">
      <div className="overflow-hidden">
        <div
          className="flex transition-transform duration-700 ease-[cubic-bezier(0.4,0,0.2,1)]"
          style={{ transform: `translateX(-${index * 100}%)` }}
        >
          {cards.map((card) => (
            <div key={card.title} className="min-w-full">
              <CardFace card={card} />
            </div>
          ))}
        </div>
      </div>
      <div className="mt-6 flex items-center justify-center gap-6">
        <button
          type="button"
          aria-label={prevLabel}
          className="flex size-9 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition-colors hover:border-slate-300 hover:text-slate-900"
          onClick={() => go(-1)}
        >
          <ChevronLeft className="size-4" />
        </button>
        <button
          type="button"
          aria-label={nextLabel}
          className="flex size-9 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition-colors hover:border-slate-300 hover:text-slate-900"
          onClick={() => go(1)}
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  );
}
