import { boundsForUserCount } from "./engine.js";

/**
 * Synthetic map for design/visual testing, NOT historical user submissions.
 * No sensitive data, credentials, account ids or session information.
 */
export const demoSeed = Object.freeze({
  date: "2026-10-01",
  bounds: Object.freeze(boundsForUserCount(0)),
  cells: Object.freeze([
    { x: -9, y: -3, char: "文", n: 7 },
    { x: 9, y: -5, char: "海", n: 7 },
    { x: 2, y: 9, char: "森", n: 6 },
    { x: -12, y: 9, char: "星", n: 6 },
    { x: 1, y: 0, char: "光", n: 5 },
  ].map(Object.freeze)),
});
