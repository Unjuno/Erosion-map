/**
 * Pure, incremental ranking projection of verified daily snapshots.
 * One day's state is examined at a time; earlier cell arrays are not retained.
 * The caller must verify snapshot hashes before ingesting.
 */
export function createRankingAccumulator() {
  const daysByGlyph = new Map();
  let latestStats = new Map();
  let latestDate = null;
  let latestOccupied = 0;
  let dayCount = 0;
  return Object.freeze({
    accept(state) {
      if (!state || typeof state.date !== "string" || !Array.isArray(state.cells)) {
        throw new TypeError("invalid ranking snapshot");
      }
      if (latestDate !== null && state.date <= latestDate) {
        throw new RangeError("archive day order is invalid");
      }
      const stats = new Map();
      for (const cell of state.cells) {
        if (typeof cell.char !== "string" || !Number.isSafeInteger(cell.n) || cell.n < 1) {
          throw new RangeError("invalid ranking cell");
        }
        const item = stats.get(cell.char) ?? { cells: 0, strength: 0 };
        item.cells++;
        item.strength += cell.n;
        if (!Number.isSafeInteger(item.strength) || !Number.isSafeInteger(item.cells)) {
          throw new RangeError("ranking total exceeds safe integer range");
        }
        stats.set(cell.char, item);
      }
      for (const char of stats.keys()) {
        daysByGlyph.set(char, (daysByGlyph.get(char) ?? 0) + 1);
      }
      latestStats = stats;
      latestDate = state.date;
      latestOccupied = state.cells.length;
      dayCount++;
    },
    result() {
      return {
        date: latestDate, occupied: latestOccupied, days: dayCount,
        entries: [...latestStats.entries()].map(([char, item]) => ({
          char, cells: item.cells, strength: item.strength,
          days: daysByGlyph.get(char) ?? 0,
        })),
      };
    },
  });
}
