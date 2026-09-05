import { useEffect, useRef, type ReactNode } from 'react';

/**
 * The one component in the panel whose geometry depends on data — and therefore the one the CSP
 * decides the implementation of.
 *
 * `style-src 'self'` with no `unsafe-inline` blocks a `style` attribute outright. MDN's
 * `style-src-attr` page says setting properties on an element's `style` *object* is **not**
 * covered, which is the CSSOM path React DOM uses for `style={{}}` — so `style={{ width }}`
 * would be expected to work. Expected is not guaranteed: browsers have historically reported a
 * violation for that path while still applying the style, and the one data-driven component in
 * this panel is not resting on that.
 *
 * So the value goes in through `element.style.setProperty('--gauge-fill', …)` — the form MDN
 * documents as allowed — and the stylesheet reads it with `width: var(--gauge-fill)`. There is
 * no `style` attribute in the markup at any point, which
 * `tests/integration/client-discipline.test.ts` enforces for the whole client.
 *
 * **A null fraction draws nothing.** `limitBytes: null` means the container reports no limit, so
 * there is no denominator and no percentage; a zero-width bar would say "using nothing" and a
 * full one would say "out of memory". The caller renders the sentence instead — see
 * `resources.noLimit` in the dictionary.
 */
export function Gauge({
  fraction,
  label,
}: {
  fraction: number | null;
  /** For a screen reader, which cannot see a bar. */
  label: string;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    // Clamped, because a cgroup can report `memory.current` above `memory.max` for a moment
    // during reclaim, and a bar wider than its track is a layout bug on top of a memory problem.
    const percent = fraction === null ? 0 : Math.min(100, Math.max(0, fraction * 100));
    element.style.setProperty('--gauge-fill', `${percent.toFixed(1)}%`);
  }, [fraction]);

  if (fraction === null) return null;

  const band = fraction >= 0.9 ? 'gauge gauge-danger' : fraction >= 0.75 ? 'gauge gauge-warn' : 'gauge';

  return (
    <div
      className={band}
      role="meter"
      aria-label={label}
      aria-valuenow={Math.round(fraction * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="gauge-bar" ref={ref} />
    </div>
  );
}
