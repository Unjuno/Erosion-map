import { advanceOneDay } from "./engine.js";
import { nextIsoDay } from "./calendar.js";
import { demoSeed } from "./demo-data.js";
import { loadPublishedArchive } from "./archive.js";

const id = (key) => document.getElementById(key);
const countText = (number) => Number(number).toLocaleString("ja-JP");
let entries = [];
let selectedSnapshots = [];

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
async function setup() {
  const message = id("rankingStatus");
  let source = "合成デモ";
  let states;
  try {
    const archive = await loadPublishedArchive({ limit: 30 });
    states = archive.states;
    source = archive.source === "api"
      ? "DBの日次確定スナップショット" : "保存された静的スナップショット";
  } catch {
    states = fakeHistory();
  }
  selectedSnapshots = states;
  entries = calcRanking(states);
  const latest = states[states.length - 1];
  id("rankingDate").textContent = "表示日: " + latest.date;
  id("historyDays").textContent = countText(states.length) + " 日";
  id("totalFactions").textContent = countText(entries.length);
  id("totalOccupied").textContent = countText(latest.cells.length);
  message.textContent = "データ元：" + source +
    "。表示値は最新スナップショット、出現日数は読み込み済み期間内の集計です。";
  drawRanking();
}
id("rankingSort").addEventListener("change", drawRanking);
id("rankingFilter").addEventListener("input", drawRanking);
await setup();
