/**
 * Validated, deterministic daily pipeline. All inputs are pure data.
 * This module does NOT authenticate callers, persist data or assign revisions.
 * The trusted backend must enforce those properties.
 */
import {
  advanceOneDay, boundsForUserCount, normalizeGlyph, resolveCollision,
  type Bounds, type Cell, type Claim, type Snapshot,
} from "./engine.js";
import { assertIsoDay, nextIsoDay } from "./calendar.js";

export type DailyPost = Readonly<{
  userId: string;
  date: string;
  revision: number; // strictly increasing server-assigned sequence per user/day
  x: number;
  y: number;
  char: string;
}>;

export type DayConfig = Readonly<{
  date: string;
  /** The trusted server decides N; never accept an untrusted client N. */
  postStrength?: number;
  /** Optional: monotonically expand bounds based on the registered user count. */
  registeredUserCount?: number;
}>;

function safeInteger(value: number, label: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(label + " must be a safe integer >= " + minimum);
  }
}
function position(x: number, y: number): string { return String(x) + "," + String(y); }
function within(b: Bounds, x: number, y: number): boolean {
  return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
}

/** Coalesce multiple same-day submissions: only the last server revision counts. */
export function selectFinalPosts(
  records: readonly DailyPost[], date: string,
): readonly DailyPost[] {
  assertIsoDay(date);
  const latest = new Map<string, DailyPost>();
  for (const record of records) {
    if (!/^[A-Za-z0-9._~-]{1,128}$/.test(record.userId)) {
      throw new RangeError("userId must be an opaque, nonempty stable identifier");
    }
    assertIsoDay(record.date);
    if (record.date !== date) throw new RangeError("post date does not match processing day");
    safeInteger(record.revision, "revision", 1);
    safeInteger(record.x, "x", Number.MIN_SAFE_INTEGER);
    safeInteger(record.y, "y", Number.MIN_SAFE_INTEGER);
    const normalized: DailyPost = { ...record, char: normalizeGlyph(record.char) };
    const current = latest.get(record.userId);
    if (current !== undefined && current.revision === normalized.revision) {
      throw new RangeError("same user/day revision was reused");
    }
    if (current === undefined || normalized.revision > current.revision) {
      latest.set(record.userId, normalized);
    }
  }
  return [...latest.values()].sort((a, b) =>
    a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0
  );
}

/**
 * From previous day -> apply final posts -> one synchronous erosion generation.
 * Default postStrength=1 is intentional and means posts do not spread by themselves.
 */
export function buildDailySnapshot(
  previous: Snapshot,
  records: readonly DailyPost[],
  config: DayConfig,
): Snapshot {
  const expected = nextIsoDay(previous.date);
  assertIsoDay(config.date);
  if (config.date !== expected) {
    throw new RangeError("daily states must be generated exactly one calendar day apart");
  }
  const strength = config.postStrength ?? 1;
  safeInteger(strength, "postStrength", 1);
  if (config.registeredUserCount !== undefined) {
    safeInteger(config.registeredUserCount, "registeredUserCount", 0);
  }

  const wanted = config.registeredUserCount === undefined
    ? previous.bounds : boundsForUserCount(config.registeredUserCount);
  // Never shrink, clip or rebase the existing coordinate grid.
  const bounds: Bounds = {
    minX: Math.min(previous.bounds.minX, wanted.minX),
    maxX: Math.max(previous.bounds.maxX, wanted.maxX),
    minY: Math.min(previous.bounds.minY, wanted.minY),
    maxY: Math.max(previous.bounds.maxY, wanted.maxY),
  };

  const occupants = new Map<string, Cell>();
  for (const cell of previous.cells) {
    const index = position(cell.x, cell.y);
    if (occupants.has(index)) throw new RangeError("duplicate cell in previous snapshot");
    occupants.set(index, { ...cell });
  }

  const postClaims = new Map<string, { x: number; y: number; claims: Claim[] }>();
  for (const post of selectFinalPosts(records, config.date)) {
    if (!within(bounds, post.x, post.y)) {
      throw new RangeError("post lies outside current map bounds");
    }
    const index = position(post.x, post.y);
    let target = postClaims.get(index);
    if (target === undefined) {
      target = { x: post.x, y: post.y, claims: [] };
      postClaims.set(index, target);
    }
    target.claims.push({ char: post.char, n: strength });
  }

  for (const [index, target] of postClaims) {
    const resident = occupants.get(index);
    const claims: Claim[] = resident === undefined
      ? target.claims : [{ char: resident.char, n: resident.n }, ...target.claims];
    const result = resolveCollision(claims);
    if (result === null) occupants.delete(index);
    else occupants.set(index, { x: target.x, y: target.y, ...result });
  }

  return advanceOneDay({
    date: previous.date, bounds, cells: [...occupants.values()],
  }, config.date);
}
