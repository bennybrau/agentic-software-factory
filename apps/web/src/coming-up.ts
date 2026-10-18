import type { TodayWire } from '@asf/shared';

/**
 * The Activity page's one-line "Coming up:" summary of recurring tasks due in the
 * next 24h (#188). Pure, so it is unit-tested without a DOM. Same local day →
 * "at 9:00 AM", the next day → "tomorrow 9:00 AM", already due → "any moment".
 * `timeZone` defaults to the browser's own.
 */
export function comingUpText(items: Pick<TodayWire['comingUp'][number], 'title' | 'nextRunAt'>[], now: Date, timeZone?: string): string {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  // Newer ICU puts a narrow no-break space before AM/PM; keep the text plain.
  const time = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(d).replace(/\s/g, ' ');
  return items.map((i) => {
    const at = new Date(i.nextRunAt);
    if (at.getTime() <= now.getTime()) return `${i.title} any moment`;
    return day.format(at) === day.format(now) ? `${i.title} at ${time(at)}` : `${i.title} tomorrow ${time(at)}`;
  }).join(' · ');
}
