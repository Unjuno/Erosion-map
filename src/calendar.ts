/** ISO calendar utilities. Scheduling uses the configured site's time zone. */
export function assertIsoDay(day: string): void {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new RangeError("day must be an ISO date (YYYY-MM-DD)");
  }
  const parsed = new Date(day + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    throw new RangeError("invalid ISO calendar day");
  }
}

/** Return the immediate next calendar day; rejects impossible dates and overflow. */
export function nextIsoDay(day: string): string {
  assertIsoDay(day);
  const parsed = new Date(day + "T00:00:00.000Z");
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  const following = parsed.toISOString().slice(0, 10);
  assertIsoDay(following);
  return following;
}

/** Site-defined day boundary; defaults to Japanese Standard Time. */
export function dayAtInstant(instant: Date, timeZone = "Asia/Tokyo"): string {
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) {
    throw new RangeError("instant must be a valid Date");
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant);
  const field = (type: string): string => {
    const part = parts.find((item) => item.type === type);
    if (part === undefined) throw new Error("missing calendar field: " + type);
    return part.value;
  };
  const day = [field("year"), field("month"), field("day")].join("-");
  assertIsoDay(day);
  return day;
}
