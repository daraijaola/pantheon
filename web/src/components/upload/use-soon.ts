"use client";

import { useEffect, useRef, useState } from "react";

/** "Get uploaded" isn't open yet: a click swaps the label to "Opening soon" for a moment. */
export function useSoon(ms = 2000) {
  const [soon, setSoon] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    setSoon(true);
    timer.current = setTimeout(() => setSoon(false), ms);
  };
  return { soon, show };
}
