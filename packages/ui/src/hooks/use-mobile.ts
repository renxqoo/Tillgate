// 移动端断点判断: 与 base-nova sidebar 预设一致(<768px 视为移动端), 首帧返回 false
import { useMediaQuery } from './use-media-query';

export function useIsMobile() {
  return !!useMediaQuery('(max-width: 767px)');
}
