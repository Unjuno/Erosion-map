import { advanceOneDay } from "./engine.js";
import { nextIsoDay } from "./calendar.js";
import { demoSeed } from "./demo-data.js";
import { visitPublishedArchive, ArchiveError } from "./archive.js";
import { createRankingAccumulator } from "./ranking-aggregate.js";

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
async function setup() {
  const message = id("rankingStatus");
  let source = "合成デモ（保存なし）";
  let summary;
  try {
    const counter = createRankingAccumulator();
    const archive = await visitPublishedArchive({
      limit: 30, onSnapshot: state => counter.accept(state),
    });
    summary = counter.result();
    source = archive.source === "api"
      ? "DBの日次確定スナップショット" : "SHA-256検証済みの静的スナップショット";
  } catch (error) {
    if (error instanceof ArchiveError && error.kind === "empty") {
      const states = fakeHistory();
      const counter = createRankingAccumulator();
      for (const snapshot of states) counter.accept(snapshot);
      summary = counter.result();
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
