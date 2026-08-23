// class 合并工具:clsx 条件拼接 + tailwind-merge 冲突消解(后者胜出)
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
