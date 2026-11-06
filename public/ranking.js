import { advanceOneDay } from "./engine.js";
import { nextIsoDay } from "./calendar.js";
import { demoSeed } from "./demo-data.js";
import { visitPublishedArchive, ArchiveError } from "./archive.js";

const id = (key) => document.getElementById(key);
const countText = (number) => Number(number).toLocaleString("ja-JP");
let entries = [];

function fakeHistory() {
  const output = [demoSeed];
  for (let index = 0; index < 12; index++) {
    const last = output[output.length - 1];
    output.push(advanceOneDay(last, nextIsoDay(last.date)));
  }
  return output;
}
function calcRanking(states) {
  const latest = states[states.length - 1];
  const stats = new Map();
  for (const cell of latest.cells) {
    const stat = stats.get(cell.char) ?? { cells: 0, strength: 0, days: 0 };
    stat.cells++;
    stat.strength += cell.n;
    stats.set(cell.char, stat);
  }
  for (const snapshot of states) {
    const chars = new Set(snapshot.cells.map((cell) => cell.char));
    for (const char of chars) {
      const stat = stats.get(char);
      if (stat) stat.days++;
    }
  }
  return [...stats.entries()].map(([char, data]) => ({ char, ...data }));
}
function glyphColor(char) {
  const palette = ["#c6f08f", "#ecb67e", "#9cb3ee", "#e29fc2",
    "#87d3c6", "#ead88c", "#bbabeb", "#f09b83"];
  let hash = 2166136261;
  for (const scalar of char) hash = Math.imul(hash ^ scalar.codePointAt(0), 16777619);
  return palette[(hash >>> 0) % palette.length];
}
function drawRanking() {
  const sort = id("rankingSort").value;
  const filter = id("rankingFilter").value.normalize("NFC");
  const rows = [...entries].filter((entry) => entry.char.includes(filter)).sort((a, b) =>
    b[sort] - a[sort] || (a.char < b.char ? -1 : a.char > b.char ? 1 : 0));
  const target = id("rankingRows");
  target.replaceChildren();
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const empty = document.createElement("td");
    empty.colSpan = 5;
    empty.textContent = "該当する勢力はありません。";
    tr.append(empty);
    target.append(tr);
    return;
  }
  for (const [index, entry] of rows.entries()) {
    const tr = document.createElement("tr");
    const rank = document.createElement("td");
    rank.className = "rank-index" + (index === 0 ? " first" : "");
    rank.textContent = String(index + 1).padStart(2, "0");

    const title = document.createElement("td");
    const glyph = document.createElement("span");
    glyph.className = "glyph";
    const dot = document.createElement("span");
    dot.className = "glyph-dot";
    dot.style.backgroundColor = glyphColor(entry.char);
    const character = document.createElement("span");
    character.textContent = entry.char;
    glyph.append(dot, character);
    title.append(glyph);
    tr.append(rank, title);
    for (const column of ["cells", "strength", "days"]) {
      const td = document.createElement("td");
      td.className = "numeric";
      td.textContent = countText(entry[column]);
      tr.append(td);
    }
    target.append(tr);
  }
}
/**
 * Only the latest day's cells and each glyph's occurrence counter are
 * retained. Verified earlier maps can be discarded immediately.
 */
function rankingAccumulator() {
  const daysByGlyph = new Map();
  let latestStats = new Map();
  let latestDate = null;
  let latestOccupied = 0;
  let dayCount = 0;
  return {
    accept(state) {
      if (latestDate !== null && state.date <= latestDate) {
        throw new RangeError("archive day order is invalid");
      }
      const stats = new Map();
      for (const cell of state.cells) {
        const item = stats.get(cell.char) ?? { cells: 0, strength: 0 };
        item.cells++;
        item.strength += cell.n;
        if (!Number.isSafeInteger(item.strength)) {
          throw new RangeError("ranking strength exceeds safe integer range");
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
          char, ...item, days: daysByGlyph.get(char) ?? 0,
        })),
      };
    },
  };
}
async function setup() {
  const message = id("rankingStatus");
  let source = "合成デモ（保存なし）";
  let summary;
  try {
    const counter = rankingAccumulator();
    const archive = await visitPublishedArchive({
      limit: 30, onSnapshot: state => counter.accept(state),
    });
    summary = counter.result();
    source = archive.source === "api"
      ? "DBの日次確定スナップショット" : "SHA-256検証済みの静的スナップショット";
  } catch (error) {
    if (error instanceof ArchiveError && error.kind === "empty") {
      const states = fakeHistory();
      const latest = states.at(-1);
      summary = {
        entries: calcRanking(states), occupied: latest.cells.length,
        date: latest.date, days: states.length,
      };
    } else {
      // A present API with broken hashes or an unexpected transport
      // error is NOT equivalent to there being no archive. Do not fabricate
      // ranks that could be mistaken for persisted user contributions.
      entries = [];
      id("rankingDate").textContent = "表示日: —";
      id("historyDays").textContent = "0 日";
      id("totalFactions").textContent = "0";
      id("totalOccupied").textContent = "0";
      message.setAttribute("role", "alert");
      message.textContent = error instanceof ArchiveError &&
        error.kind === "integrity"
        ? "履歴データの整合性を検証できません。ランキングの表示を中止しました。"
        : "履歴データを取得できません。デモ順位には置き換えず、表示を中止しました。";
      drawRanking();
      return;
    }
  }
  entries = summary.entries;
  id("rankingDate").textContent = "表示日: " + summary.date;
  id("historyDays").textContent = countText(summary.days) + " 日";
  id("totalFactions").textContent = countText(entries.length);
  id("totalOccupied").textContent = countText(summary.occupied);
  message.textContent = "データ元：" + source +
    "。表示値は最新スナップショット、出現日数は読み込み済み期間内の集計です。";
  drawRanking();
}
id("rankingSort").addEventListener("change", drawRanking);
id("rankingFilter").addEventListener("input", drawRanking);
await setup();
