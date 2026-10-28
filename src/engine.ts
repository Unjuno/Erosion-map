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
export type ErosionRules = Readonly<{
  sameGlyphMode?: "sum" | "max";
  /** Experimental: N=1 sends influence 1 instead of 0. Requires max grouping. */
  minimumOutgoingInfluence?: 0 | 1;
}>;

function verifyMode(rules: ErosionRules): "sum" | "max" {
  const mode = rules.sameGlyphMode ?? "sum";
  if (mode !== "sum" && mode !== "max") {
    throw new RangeError("sameGlyphMode must be 'sum' or 'max'");
  }
  const floor = rules.minimumOutgoingInfluence ?? 0;
  if (floor !== 0 && floor !== 1) {
    throw new RangeError("minimumOutgoingInfluence must be 0 or 1");
  }
  if (floor === 1 && mode !== "max") {
    throw new RangeError("N=1 propagation requires max grouping");
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
 * Memory-bounded implementation of the exact existing max-grouping rules.
 *
 * For reasonable rectangular map sizes, numeric column-major arrays replace
 * O(cells) string keys, receiver objects, adjacency arrays and a large sort.
 * Receivers are still independent: only the previous generation is read.
 * x/y iteration is valid because receiver order cannot influence outcomes.
 *
 * The historic sum model and extremely large sparse bounds continue through
 * the reference implementation below, without changing their semantics.
 */
function advanceBoundedDense(previous: Snapshot, nextDate: string, floor: 0 | 1): Snapshot {
  const b = previous.bounds;
  const height = b.maxY - b.minY + 1;
  const width = b.maxX - b.minX + 1;
  const length = height * width;
  const owners = new Uint32Array(length);
  const strengths = new Float64Array(length);
  const ids = new Map<string, number>();
  const normalizations = new Map<string, string>();
  const glyphs: string[] = [""];
  for (const cell of previous.cells) {
    assertInteger(cell.x, "cell.x");
    assertInteger(cell.y, "cell.y");
    assertPositive(cell.n, "cell.n");
    if (!inside(b, cell.x, cell.y)) throw new RangeError("cell outside bounds");
    let char = normalizations.get(cell.char);
    if (char === undefined) {
      char = normalizeGlyph(cell.char);
      normalizations.set(cell.char, char);
    }
    let owner = ids.get(char);
    if (owner === undefined) {
      owner = glyphs.length;
      glyphs.push(char);
      ids.set(char, owner);
    }
    const index = (cell.x - b.minX) * height + (cell.y - b.minY);
    if (owners[index] !== 0) throw new RangeError("duplicate cell at " + key(cell.x, cell.y));
    owners[index] = owner;
    strengths[index] = cell.n;
  }

  const output: Cell[] = [];
  const candidateOwners = new Uint32Array(5);
  const candidateStrengths = new Float64Array(5);
  let count = 0;
  // Every receiver has at most five claims (resident and four neighbours).
  // Use the same max-by-glyph grouping and strongest-minus-rivals semantics
  // as resolveCollision, but without per-cell allocations.
  const addClaim = (index: number, resident: boolean): void => {
    if (index < 0) return;
    const owner = owners[index]!;
    if (owner === 0) return;
    const strength = resident ? strengths[index]! : Math.max(strengths[index]! - 1, floor);
    if (strength <= 0) return;
    for (let k = 0; k < count; k++) {
      if (candidateOwners[k] === owner) {
        candidateStrengths[k] = Math.max(candidateStrengths[k]!, strength);
        return;
      }
    }
    candidateOwners[count] = owner;
    candidateStrengths[count] = strength;
    count++;
  };

  for (let ix = 0; ix < width; ix++) {
    const x = b.minX + ix;
    for (let iy = 0; iy < height; iy++) {
      const y = b.minY + iy;
      const index = ix * height + iy;
      const resident = owners[index]!;
      const north = iy > 0 ? index - 1 : -1;
      const south = iy + 1 < height ? index + 1 : -1;
      const east = ix + 1 < width ? index + height : -1;
      const west = ix > 0 ? index - height : -1;
      // "Fully surrounded" means all four orthogonal neighbours exist and
      // share the resident's glyph, even if their outgoing claim is zero.
      if (resident !== 0 && north !== -1 && south !== -1 &&
          east !== -1 && west !== -1 &&
          owners[north] === resident && owners[south] === resident &&
          owners[east] === resident && owners[west] === resident) {
        output.push({ x, y, char: glyphs[resident]!, n: strengths[index]! });
        continue;
      }
      count = 0;
      addClaim(index, true);
      addClaim(north, false);
      addClaim(east, false);
      addClaim(south, false);
      addClaim(west, false);
      if (count === 0) continue;
      let winnerIndex = 0;
      for (let k = 1; k < count; k++) {
        if (candidateStrengths[k]! > candidateStrengths[winnerIndex]!) winnerIndex = k;
      }
      let remainder = candidateStrengths[winnerIndex]!;
      for (let k = 0; k < count && remainder > 0; k++) {
        if (k !== winnerIndex) remainder -= candidateStrengths[k]!;
      }
      if (remainder > 0) {
        output.push({ x, y, char: glyphs[candidateOwners[winnerIndex]!]!, n: remainder });
      }
    }
  }
  return { date: nextDate, bounds: { ...b }, cells: output };
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
  const minimumOutgoing = rules.minimumOutgoingInfluence ?? 0;
  const b = previous.bounds;
  for (const [label, value] of Object.entries(b)) assertInteger(value, "bounds." + label);
  if (b.minX > b.maxX || b.minY > b.maxY) throw new RangeError("bounds must be nonempty");
  const height = b.maxY - b.minY + 1;
  const width = b.maxX - b.minX + 1;
  // The max model is non-amplifying. Dense typed arrays use ~12 bytes/cell
  // independent of the number of active receivers. Guard giant sparse maps.
  if ((rules.sameGlyphMode ?? "sum") === "max" &&
      Number.isSafeInteger(width) && Number.isSafeInteger(height) &&
      width > 0 && height > 0 && width <= Math.floor(1_000_000 / height)) {
    return advanceBoundedDense(previous, nextDate, minimumOutgoing);
  }
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
    const incoming: Claim[] = neighbors.flatMap((cell) => {
      if (cell === undefined) return [];
      const strength = Math.max(cell.n - 1, minimumOutgoing);
      return strength > 0 ? [{ char: cell.char, n: strength }] : [];
    });
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
