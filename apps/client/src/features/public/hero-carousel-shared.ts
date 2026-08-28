export interface CarouselModel {
  name: string;
  contextLabel: string;
}

export interface CarouselStat {
  label: string;
  value: string;
}

export interface CarouselCard {
  href: string;
  eyebrow: string;
  title: string;
  sub: string;
  theme: 'models' | 'api' | 'usage' | 'wallet';
  models?: CarouselModel[];
  stats?: CarouselStat[];
  freeChip?: string;
  featuredLabel?: string;
  host?: string;
  exampleLabel?: string;
}
