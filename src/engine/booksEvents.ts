import { useEffect } from 'react';

const listeners = new Set<() => void>();

export function notifyBooksChanged() {
  listeners.forEach((l) => l());
}

export function useBooksChanged(listener: () => void, throttleMs = 700) {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const throttled = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        listener();
      }, throttleMs);
    };
    listeners.add(throttled);
    return () => {
      listeners.delete(throttled);
      if (timer) clearTimeout(timer);
    };
  }, [listener, throttleMs]);
}
