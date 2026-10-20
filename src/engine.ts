import { assertIsoDay } from "./calendar.js";

/**
 * Pure receiver-driven erosion simulation, provisional v0.1.
 * Authentication, posting, persistence and cron are intentionally separate.
 * Unresolved design decisions are documented in docs/ALGORITHM.md.
 */
export type Bounds = Readonly<{
  minX: number; maxX: number; minY: number; maxY: number;
}>;
export type Cell = Readonly<{
  x: number; y: number; char: string; n: number;
}>;
export type Snapshot = Readonly<{
  date: string; bounds: Bounds; cells: readonly Cell[];
}>;
export type Claim = Readonly<{ char: string; n: number }>;
export type CollisionResult = Readonly<{ char: string; n: number }> | null;
/** The default "sum" remains the unapproved historical simulation model. */
export type ErosionRules = Readonly<{ sameGlyphMode?: "sum" | "max" }>;

function verifyMode(rules: ErosionRules): "sum" | "max" {
  const mode = rules.sameGlyphMode ?? "sum";
  if (mode !== "sum" && mode !== "max") {
    throw new RangeError("sameGlyphMode must be 'sum' or 'max'");
  }
  return mode;
}
type Point = Readonly<{ x: number; y: number }>;

const directions: readonly Point[] = [
  { x: 0, y: -1 }, { x: 1, y: 0 },
  { x: 0, y: 1 }, { x: -1, y: 0 },
];
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });

function assertInteger(value: number, label: string, minimum = Number.MIN_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new RangeError(label + " must be a safe integer >= " + minimum);
}
function assertPositive(value: number, label: string): void {
  assertInteger(value, label, 1);
}
function addChecked(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new RangeError("influence exceeds safe integer range");
  return sum;
}
function key(x: number, y: number): string { return x + "," + y; }
function inside(bounds: Bounds, x: number, y: number): boolean {
  return x >= bounds.minX && x <= bounds.maxX &&
         y >= bounds.minY && y <= bounds.maxY;
}
export function boundsForUserCount(userCount: number): Bounds {
  assertInteger(userCount, "userCount", 0);
  const size = Math.max(500, userCount);
  const min = -Math.floor(size / 2);
  return { minX: min, maxX: min + size - 1, minY: min, maxY: min + size - 1 };
}
export function normalizeGlyph(char: string): string {
  if (typeof char !== "string") throw new TypeError("char must be a string");
  const glyph = char.normalize("NFC");
  if (glyph.length < 1 || glyph.length > 32 ||
      [...segmenter.segment(glyph)].length !== 1) {
    throw new RangeError("char must be exactly one grapheme (max 32 UTF-16 units)");
  }
  if (/^[\p{White_Space}\p{Cc}\p{Cf}]+$/u.test(glyph) ||
      /[\u0000-\u001F\u007F-\u009F]/u.test(glyph)) {
    throw new RangeError("invisible whitespace or control characters are not accepted");
  }
  return glyph;
}

/**
 * PROVISIONAL collision rule:
 * 1) group identical glyphs by "sum" (existing default) or "max" (experimental);
 * 2) strongest glyph is the only possible survivor;
 * 3) subtract the sum of every other glyph;
 * 4) if the remainder is not positive, return empty.
 *
 * This resolves three-way conflicts deterministically and without input-order bias.
 */
export function resolveCollision(
  claims: readonly Claim[], rules: ErosionRules = {},
): CollisionResult {
  const mode = verifyMode(rules);
  const grouped = new Map<string, number>();
  for (const claim of claims) {
    const char = normalizeGlyph(claim.char);
    assertPositive(claim.n, "claim.n");
    const existing = grouped.get(char) ?? 0;
    grouped.set(char, mode === "max"
      ? Math.max(existing, claim.n)
      : addChecked(existing, claim.n));
  }
  const factions = [...grouped.entries()]
    .map(([char, n]) => ({ char, n }))
    .sort((a, b) => b.n - a.n || (a.char < b.char ? -1 : a.char > b.char ? 1 : 0));
  const strongest = factions[0];
  if (strongest === undefined) return null;
  let remainder = strongest.n;
  for (const rival of factions.slice(1)) {
    remainder -= rival.n;
    if (remainder <= 0) return null;
  }
  return { char: strongest.char, n: remainder };
}

function validateSnapshot(snapshot: Snapshot): Map<string, Cell> {
  const b = snapshot.bounds;
  for (const [label, value] of Object.entries(b))
    assertInteger(value, "bounds." + label);
  if (b.minX > b.maxX || b.minY > b.maxY)
    throw new RangeError("bounds must be nonempty");
  assertIsoDay(snapshot.date);
  const output = new Map<string, Cell>();
  for (const cell of snapshot.cells) {
    assertInteger(cell.x, "cell.x");
    assertInteger(cell.y, "cell.y");
    assertPositive(cell.n, "cell.n");
    if (!inside(b, cell.x, cell.y)) throw new RangeError("cell outside bounds");
    const char = normalizeGlyph(cell.char);
    const k = key(cell.x, cell.y);
    if (output.has(k)) throw new RangeError("duplicate cell at " + k);
    output.set(k, { x: cell.x, y: cell.y, char, n: cell.n });
  }
  return output;
}

/**
 * One synchronous day-tick: read only the previous state, so changing
 * receiver iteration order cannot modify the result.
 *
 * Pending approval: residents defend with current n; a cell fully enclosed
 * by the same character is frozen at its original strength.
 */
export function advanceOneDay(
  previous: Snapshot, nextDate: string, rules: ErosionRules = {},
): Snapshot {
  verifyMode(rules);
  assertIsoDay(nextDate);
  assertIsoDay(previous.date);
  if (nextDate <= previous.date)
    throw new RangeError("nextDate must be later than the snapshot date");
  const current = validateSnapshot(previous);
  const receivers = new Map<string, Point>();
  const addReceiver = (x: number, y: number): void => {
    if (inside(previous.bounds, x, y))
      receivers.set(key(x, y), { x, y });
  };
  for (const cell of current.values()) {
    addReceiver(cell.x, cell.y);
    for (const direction of directions)
      addReceiver(cell.x + direction.x, cell.y + direction.y);
  }
  // Receiver priority: empty/low n, then x, then y.
  const ordered = [...receivers.values()].sort((a, b) =>
    ((current.get(key(a.x, a.y))?.n ?? 0) -
     (current.get(key(b.x, b.y))?.n ?? 0)) ||
    a.x - b.x || a.y - b.y
  );
  const output: Cell[] = [];
  for (const { x, y } of ordered) {
    const resident = current.get(key(x, y));
    const neighbors = directions.map((d) => current.get(key(x + d.x, y + d.y)));
    if (resident !== undefined &&
        neighbors.every((neighbor) => neighbor?.char === resident.char)) {
      output.push(resident);
      continue;
    }
    const incoming: Claim[] = neighbors
      .filter((cell): cell is Cell => cell !== undefined && cell.n >= 2)
      .map((cell) => ({ char: cell.char, n: cell.n - 1 }));
    if (incoming.length === 0) {
      if (resident !== undefined) output.push(resident);
      continue;
    }
    const claims: Claim[] = resident === undefined
      ? incoming
      : [{ char: resident.char, n: resident.n }, ...incoming];
    const survivor = resolveCollision(claims, rules);
    if (survivor !== null) output.push({ x, y, ...survivor });
  }
  output.sort((a, b) => a.x - b.x || a.y - b.y);
  return { date: nextDate, bounds: { ...previous.bounds }, cells: output };
}
