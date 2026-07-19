// Shared date-matching logic for the master schedule — used by both the
// kiosk (to auto-detect what a scan belongs to right now) and the admin
// Week/Month calendar views (to render what's on the schedule for a given
// date), so the two never drift out of sync on what "applies on this date"
// means.

export function dateToKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function keyToDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Which schedule entries are "live" on a specific calendar date:
//  - single-date entries whose `date` matches exactly, plus
//  - recurring entries whose day-of-week matches, the date falls within
//    [startDate, endDate] (either bound may be absent — absent startDate
//    means "no lower bound", absent endDate means "still ongoing"), and
//    which don't have a cancellation recorded for that specific date.
export function getEntriesForDate(date, scheduleEntries, cancellations) {
  const dateKey = dateToKey(date);
  const dow = date.getDay();

  return scheduleEntries.filter((e) => {
    if (e.kind === "single") {
      return e.date === dateKey;
    }
    // Recurring (also the default for legacy entries with no `kind` field).
    if (!e.days || !e.days.includes(dow)) return false;
    if (e.startDate && dateKey < e.startDate) return false;
    if (e.endDate && dateKey > e.endDate) return false;
    const isCanceled = cancellations.some((c) => c.scheduleId === e.id && c.date === dateKey);
    if (isCanceled) return false;
    return true;
  });
}
