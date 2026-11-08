export function afterPaint(setup: () => void | (() => void), element?: Element | null): () => void {
  let frame = 0, idle = 0, timer = 0;
  let dispose: void | (() => void);
  let cancelled = false;
  const run = () => { if (!cancelled) dispose = setup(); };
  const schedule = () => {
    if (cancelled) return;
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (window.requestIdleCallback) idle = window.requestIdleCallback(run, { timeout: 500 });
        else timer = window.setTimeout(run, 0);
      });
    });
  };
  const observer: IntersectionObserver | null = element ? new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    observer?.disconnect();
    schedule();
  }) : null;
  if (element) observer?.observe(element);
  else schedule();
  return () => {
    cancelled = true;
    observer?.disconnect();
    cancelAnimationFrame(frame);
    if (idle) window.cancelIdleCallback(idle);
    window.clearTimeout(timer);
    dispose?.();
  };
}
