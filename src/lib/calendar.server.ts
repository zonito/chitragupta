/**
 * The calendar side of the display-month rule: the app presents the
 * Europe/London calendar month once it has begun, even before any
 * statement has landed in it (see buildSnapshot). Server-only — the
 * snapshot builder and the API handlers are the consumers.
 *
 * CHITRAGUPTA_TODAY (YYYY-MM-DD) pins "today" when set; it exists so
 * tests can pin the calendar deterministically. Production never
 * sets it.
 */

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** Today in Europe/London as YYYY-MM-DD (CHITRAGUPTA_TODAY wins when set). */
export function londonToday(): string {
  const pinned = process.env["CHITRAGUPTA_TODAY"]?.trim();
  if (pinned && DATE_SHAPE.test(pinned)) return pinned;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** The Europe/London calendar month, YYYY-MM. */
export function calendarMonthKey(): string {
  return londonToday().slice(0, 7);
}

/**
 * The display month for a store whose latest data month is
 * `latestDataMonth`: the calendar month when it is at or after the
 * latest data month, otherwise the latest data month. Never a month
 * before the data's latest, never one beyond the calendar month.
 */
export function displayMonthKey(latestDataMonth: string): string {
  const calendar = calendarMonthKey();
  return calendar > latestDataMonth ? calendar : latestDataMonth;
}
