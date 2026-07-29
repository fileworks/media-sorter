import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type UIEventHandler,
} from "react";

export interface VirtualItem {
  index: number;
  start: number;
  size: number;
}

export interface FixedWindow {
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
}

/** Constant-time range calculation used by fixed-height lists. */
export function fixedWindow(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 5,
): FixedWindow {
  const safeRow = Math.max(rowHeight, 1);
  const start = Math.max(0, Math.floor(scrollTop / safeRow) - overscan);
  const end = Math.min(total, start + Math.ceil(viewportHeight / safeRow) + overscan * 2);
  return {
    start,
    end,
    offsetTop: start * safeRow,
    totalHeight: total * safeRow,
  };
}

interface VirtualWindowOptions {
  count: number;
  estimateSize: number;
  maxHeight: number;
  emptyHeight?: number;
  overscan?: number;
  /** Changes when filtering/reordering should preserve the current anchor. */
  anchorKey?: string | null;
}

/**
 * Shared list/grid windowing with optional measured row heights.
 *
 * Callers put `data-virtual-index` on a row and pass `measureElement` as its
 * ref. Fixed-height callers can omit the ref and use the estimate throughout.
 */
export function useVirtualWindow({
  count,
  estimateSize,
  maxHeight,
  emptyHeight = 96,
  overscan = 6,
  anchorKey = null,
}: VirtualWindowOptions) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sizesRef = useRef(new Map<number, number>());
  const observersRef = useRef(new Map<Element, ResizeObserver>());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(maxHeight);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const anchorRef = useRef(anchorKey);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => {
      setViewportHeight(element.clientHeight || maxHeight);
      setViewportWidth(element.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [maxHeight]);

  useEffect(
    () => () => {
      for (const observer of observersRef.current.values()) observer.disconnect();
      observersRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (anchorRef.current === anchorKey) return;
    anchorRef.current = anchorKey;
    const element = scrollRef.current;
    if (element) setScrollTop(element.scrollTop);
  }, [anchorKey]);

  const layout = useMemo(() => {
    if (sizesRef.current.size === 0) {
      return {
        starts: [] as number[],
        sizes: [] as number[],
        totalSize: count * Math.max(estimateSize, 1),
        fixed: true,
      };
    }
    const starts = new Array<number>(count);
    const sizes = new Array<number>(count);
    let cursor = 0;
    for (let index = 0; index < count; index += 1) {
      starts[index] = cursor;
      const size = sizesRef.current.get(index) ?? estimateSize;
      sizes[index] = size;
      cursor += size;
    }
    return { starts, sizes, totalSize: cursor, fixed: false };
    // measurementVersion is the invalidation signal for the mutable size map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, estimateSize, measurementVersion]);

  const virtualItems = useMemo(() => {
    if (count === 0) return [];
    if (layout.fixed) {
      const range = fixedWindow(count, scrollTop, viewportHeight, estimateSize, overscan);
      return Array.from({ length: range.end - range.start }, (_, offset) => {
        const index = range.start + offset;
        return { index, start: index * Math.max(estimateSize, 1), size: Math.max(estimateSize, 1) };
      });
    }
    const lower = Math.max(0, scrollTop - overscan * estimateSize);
    const upper = scrollTop + viewportHeight + overscan * estimateSize;
    let start = 0;
    while (start < count - 1 && layout.starts[start] + layout.sizes[start] < lower) start += 1;
    let end = start;
    while (end < count && layout.starts[end] < upper) end += 1;
    const items: VirtualItem[] = [];
    for (let index = start; index < end; index += 1) {
      items.push({ index, start: layout.starts[index], size: layout.sizes[index] });
    }
    return items;
  }, [count, estimateSize, layout, overscan, scrollTop, viewportHeight]);

  const measureElement = useCallback((element: HTMLElement | null) => {
    if (!element || observersRef.current.has(element)) return;
    const update = () => {
      const index = Number(element.dataset.virtualIndex);
      if (!Number.isInteger(index)) return;
      const next = element.getBoundingClientRect().height;
      if (next <= 0 || sizesRef.current.get(index) === next) return;
      sizesRef.current.set(index, next);
      setMeasurementVersion((version) => version + 1);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observersRef.current.set(element, observer);
  }, []);

  const onScroll = useCallback<UIEventHandler<HTMLDivElement>>((event) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  return {
    scrollRef,
    onScroll,
    scrollTop,
    viewportHeight,
    viewportWidth,
    virtualItems,
    totalSize: layout.totalSize,
    containerHeight: count === 0 ? emptyHeight : Math.min(layout.totalSize, maxHeight),
    measureElement,
  };
}
