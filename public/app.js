import { advanceOneDay, boundsForUserCount, normalizeGlyph } from "./engine.js";
import { buildDailySnapshot } from "./daily.js";
import { nextIsoDay } from "./calendar.js";

const byId = (id) => {
  const element = document.getElementById(id);
  if (element === null) throw new Error("Missing UI control: " + id);
  return element;
};
const canvas = byId("mapCanvas");
const ctx = canvas.getContext("2d", { alpha: false });
if (ctx === null) throw new Error("Your browser does not support Canvas 2D");

const minimumZoom = 0.03;
const maximumZoom = 5;
const glyphPalette = ["#c6f08f", "#ecb67e", "#9cb3ee", "#e29fc2",
  "#87d3c6", "#ead88c", "#bbabeb", "#f09b83"];
const seed = Object.freeze({
  date: "2026-10-01",
  bounds: boundsForUserCount(0),
  cells: Object.freeze([
    { x: -9, y: -3, char: "文", n: 7 },
    { x: 9, y: -5, char: "海", n: 7 },
    { x: 2, y: 9, char: "森", n: 6 },
    { x: -12, y: 9, char: "星", n: 6 },
    { x: 1, y: 0, char: "光", n: 5 },
  ]),
});
const steps = 12;
let snapshots = [];
let demoSnapshots = [];
let archivedSnapshots = null;
let liveMode = false;
let frameIndex = 0;
let selected = { x: 0, y: 0 };
let viewX = 0;
let viewY = 0;
let zoom = window.innerWidth < 600 ? 0.75 : 1.3;
let previewPost = null;
let previewStrength = 1;
let playback = null;
let activePointer = null;
let renderPending = false;

const format = (value) => Number(value).toLocaleString("ja-JP");
const current = () => snapshots[frameIndex];

function colorOf(char) {
  let hash = 2166136261;
  for (const scalar of char) {
    hash = Math.imul(hash ^ scalar.codePointAt(0), 16777619);
  }
  return glyphPalette[(hash >>> 0) % glyphPalette.length];
}
function clamp(value, lo, hi) { return Math.min(hi, Math.max(lo, value)); }
function inside(x, y) {
  const b = current().bounds;
  return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
}
function sizeOfCell() { return 18 * zoom; }
function snapshotAt(index) { return snapshots[clamp(index, 0, snapshots.length - 1)]; }

function buildHistory() {
  snapshots = [seed];
  for (let day = 1; day <= steps; day++) {
    const previous = snapshots[snapshots.length - 1];
    const date = nextIsoDay(previous.date);
    const updated = day === 1 && previewPost !== null
      ? buildDailySnapshot(previous, [previewPost], {
          date, postStrength: previewStrength,
        })
      : advanceOneDay(previous, date);
    snapshots.push(updated);
  }
  demoSnapshots = snapshots;
  if (liveMode && archivedSnapshots !== null) snapshots = archivedSnapshots;
  byId("dayRange").max = String(snapshots.length - 1);
  frameIndex = clamp(frameIndex, 0, snapshots.length - 1);
}

function worldToScreen(x, y) {
  const size = sizeOfCell();
  return {
    x: canvas.clientWidth / 2 + (x - viewX) * size,
    y: canvas.clientHeight / 2 + (y - viewY) * size,
  };
}
function eventToTile(event) {
  const rect = canvas.getBoundingClientRect();
  const size = sizeOfCell();
  return {
    x: Math.round(viewX + (event.clientX - rect.left - rect.width / 2) / size),
    y: Math.round(viewY + (event.clientY - rect.top - rect.height / 2) / size),
  };
}
function renderSoon() {
  if (renderPending) return;
  renderPending = true;
  window.requestAnimationFrame(() => {
    renderPending = false;
    drawMap();
  });
}
function drawMap() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width <= 0 || height <= 0) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0b1720";
  ctx.fillRect(0, 0, width, height);
  const size = sizeOfCell();
  const b = current().bounds;
  const worldOrigin = worldToScreen(b.minX - 0.5, b.minY - 0.5);
  const worldWidth = (b.maxX - b.minX + 1) * size;
  const worldHeight = (b.maxY - b.minY + 1) * size;
  ctx.fillStyle = "#101e28";
  ctx.fillRect(worldOrigin.x, worldOrigin.y, worldWidth, worldHeight);
  ctx.strokeStyle = "#5d7567";
  ctx.lineWidth = 1;
  ctx.strokeRect(worldOrigin.x + .5, worldOrigin.y + .5, worldWidth, worldHeight);

  if (size >= 12) {
    ctx.beginPath();
    ctx.strokeStyle = "rgba(125,164,160,.11)";
    ctx.lineWidth = 1;
    const firstX = Math.max(b.minX, Math.ceil(viewX - width / (2 * size) - 1));
    const lastX = Math.min(b.maxX + 1, Math.ceil(viewX + width / (2 * size) + 1));
    const firstY = Math.max(b.minY, Math.ceil(viewY - height / (2 * size) - 1));
    const lastY = Math.min(b.maxY + 1, Math.ceil(viewY + height / (2 * size) + 1));
    for (let x = firstX; x <= lastX; x++) {
      const pos = worldToScreen(x - .5, 0).x;
      ctx.moveTo(Math.round(pos) + .5, 0);
      ctx.lineTo(Math.round(pos) + .5, height);
    }
    for (let y = firstY; y <= lastY; y++) {
      const pos = worldToScreen(0, y - .5).y;
      ctx.moveTo(0, Math.round(pos) + .5);
      ctx.lineTo(width, Math.round(pos) + .5);
    }
    ctx.stroke();
  }

  for (const cell of current().cells) {
    const pos = worldToScreen(cell.x, cell.y);
    const left = pos.x - size / 2;
    const top = pos.y - size / 2;
    if (left > width || top > height || left + size < 0 || top + size < 0) continue;
    ctx.fillStyle = colorOf(cell.char);
    ctx.fillRect(left + .6, top + .6, Math.max(1, size - 1.2), Math.max(1, size - 1.2));
    if (size >= 17) {
      ctx.fillStyle = "#0e1c23";
      ctx.font = "600 " + Math.floor(Math.min(23, size * .60)) + "px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(cell.char, pos.x, pos.y, size - 2);
    }
  }
  const position = worldToScreen(selected.x, selected.y);
  if (position.x + size / 2 >= 0 && position.x - size / 2 <= width &&
      position.y + size / 2 >= 0 && position.y - size / 2 <= height) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#fefaf0";
    ctx.strokeRect(position.x - size / 2, position.y - size / 2, size, size);
  }
  byId("viewportLabel").textContent =
    "CENTER: (" + Math.round(viewX) + ", " + Math.round(viewY) + ")  /  ZOOM " +
    Math.round(zoom * 100) + "%";
}

function summarize() {
  const tally = new Map();
  for (const cell of current().cells) {
    const existing = tally.get(cell.char) ?? { count: 0, strength: 0 };
    existing.count++;
    existing.strength += cell.n;
    tally.set(cell.char, existing);
  }
  byId("occupied").textContent = format(current().cells.length);
  byId("factionCount").textContent = format(tally.size);
  const ranked = [...tally.entries()]
    .sort((a, b) => b[1].count - a[1].count ||
      (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const list = byId("ranking");
  list.replaceChildren();
  if (ranked.length === 0) {
    const text = document.createElement("p");
    text.className = "ranking-empty";
    text.textContent = "この日の勢力はありません。";
    list.append(text);
    return;
  }
  for (const [char, scores] of ranked.slice(0, 8)) {
    const line = document.createElement("div");
    line.className = "rank-row";
    const color = colorOf(char);
    const swatch = document.createElement("span");
    swatch.className = "rank-swatch";
    swatch.style.backgroundColor = color;
    const body = document.createElement("div");
    body.className = "rank-main";
    const first = document.createElement("div");
    first.className = "rank-first";
    const glyph = document.createElement("strong");
    glyph.textContent = char;
    const count = document.createElement("small");
    count.textContent = format(scores.count) + " マス";
    first.append(glyph, count);
    const bar = document.createElement("div");
    bar.className = "rank-track";
    const fill = document.createElement("span");
    fill.style.backgroundColor = color;
    fill.style.width = (100 * scores.count / ranked[0][1].count).toFixed(2) + "%";
    bar.append(fill);
    body.append(first, bar);
    const strength = document.createElement("div");
    strength.className = "rank-n";
    strength.title = "勢力値 N の合計";
    strength.textContent = "ΣN " + format(scores.strength);
    line.append(swatch, body, strength);
    list.append(line);
  }
}

function inspectSelected() {
  const cell = current().cells.find((record) =>
    record.x === selected.x && record.y === selected.y);
  byId("selectedGlyph").textContent = cell?.char ?? "—";
  byId("selectedGlyph").style.color = cell ? colorOf(cell.char) : "#9aaeba";
  byId("selectedCoords").textContent = "(" + selected.x + ", " + selected.y + ")";
  byId("selectedChar").textContent = cell?.char ?? "空白";
  byId("selectedStrength").textContent = cell ? format(cell.n) : "0";
  byId("goX").value = String(selected.x);
  byId("goY").value = String(selected.y);
}

function updateUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set("x", String(selected.x));
  url.searchParams.set("y", String(selected.y));
  url.searchParams.set("date", current().date);
  window.history.replaceState(null, "", url);
}
function updatePanels() {
  const snap = current();
  byId("dayLabel").textContent = snap.date;
  byId("dayCounter").textContent =
    "DAY " + String(frameIndex + 1).padStart(2, "0") +
    " / " + String(snapshots.length);
  byId("dayRange").value = String(frameIndex);
  byId("prevDay").disabled = frameIndex === 0;
  byId("nextDay").disabled = frameIndex === snapshots.length - 1;
  byId("mapSize").textContent =
    (snap.bounds.maxX - snap.bounds.minX + 1) +
    " × " + (snap.bounds.maxY - snap.bounds.minY + 1) + " GRID";
  inspectSelected();
  summarize();
  renderSoon();
  updateUrl();
}
function stopPlayback() {
  if (playback !== null) {
    window.clearInterval(playback);
    playback = null;
  }
  byId("togglePlay").textContent = "▶ 再生";
}
function gotoFrame(index) {
  frameIndex = clamp(index, 0, snapshots.length - 1);
  updatePanels();
  if (frameIndex === snapshots.length - 1) stopPlayback();
}
function startPlayback() {
  stopPlayback();
  if (frameIndex >= snapshots.length - 1) frameIndex = 0;
  byId("togglePlay").textContent = "Ⅱ 停止";
  gotoFrame(frameIndex);
  playback = window.setInterval(() => {
    if (frameIndex + 1 >= snapshots.length) {
      stopPlayback();
      return;
    }
    gotoFrame(frameIndex + 1);
  }, Math.round(900 / Number(byId("speed").value)));
}

function zoomAt(multiplier, localX = canvas.clientWidth / 2, localY = canvas.clientHeight / 2) {
  const oldSize = sizeOfCell();
  const worldX = viewX + (localX - canvas.clientWidth / 2) / oldSize;
  const worldY = viewY + (localY - canvas.clientHeight / 2) / oldSize;
  zoom = clamp(zoom * multiplier, minimumZoom, maximumZoom);
  const newSize = sizeOfCell();
  viewX = worldX - (localX - canvas.clientWidth / 2) / newSize;
  viewY = worldY - (localY - canvas.clientHeight / 2) / newSize;
  renderSoon();
}
function fitWorld() {
  const b = current().bounds;
  const width = b.maxX - b.minX + 1;
  const height = b.maxY - b.minY + 1;
  zoom = clamp(Math.min(
    canvas.clientWidth / (width + 15),
    canvas.clientHeight / (height + 15),
  ) / 18, minimumZoom, maximumZoom);
  viewX = (b.minX + b.maxX) / 2;
  viewY = (b.minY + b.maxY) / 2;
  renderSoon();
}
function selectCell(x, y) {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !inside(x, y)) {
    return false;
  }
  selected = { x, y };
  inspectSelected();
  renderSoon();
  updateUrl();
  return true;
}
function navigateTo(x, y) {
  if (!selectCell(x, y)) return false;
  viewX = x;
  viewY = y;
  renderSoon();
  return true;
}

byId("zoomIn").addEventListener("click", () => zoomAt(1.4));
byId("zoomOut").addEventListener("click", () => zoomAt(1 / 1.4));
byId("fitMap").addEventListener("click", fitWorld);
byId("goForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const x = Number(byId("goX").value);
  const y = Number(byId("goY").value);
  if (!navigateTo(x, y)) {
    window.alert("有効なマップ内の整数座標を指定してください。");
  }
});
byId("dayRange").addEventListener("input", (event) => {
  stopPlayback();
  gotoFrame(Number(event.currentTarget.value));
});
byId("prevDay").addEventListener("click", () => { stopPlayback(); gotoFrame(frameIndex - 1); });
byId("nextDay").addEventListener("click", () => { stopPlayback(); gotoFrame(frameIndex + 1); });
byId("togglePlay").addEventListener("click", () =>
  playback === null ? startPlayback() : stopPlayback());
byId("speed").addEventListener("change", () => {
  if (playback !== null) startPlayback();
});

canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  activePointer = {
    id: event.pointerId,
    startX: event.clientX, startY: event.clientY,
    lastX: event.clientX, lastY: event.clientY, moved: false,
  };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  if (activePointer === null || event.pointerId !== activePointer.id) return;
  if (Math.hypot(event.clientX - activePointer.startX,
    event.clientY - activePointer.startY) > 4) activePointer.moved = true;
  if (activePointer.moved) {
    viewX -= (event.clientX - activePointer.lastX) / sizeOfCell();
    viewY -= (event.clientY - activePointer.lastY) / sizeOfCell();
    renderSoon();
  }
  activePointer.lastX = event.clientX;
  activePointer.lastY = event.clientY;
});
canvas.addEventListener("pointerup", (event) => {
  if (activePointer === null || event.pointerId !== activePointer.id) return;
  if (!activePointer.moved) {
    const tile = eventToTile(event);
    selectCell(tile.x, tile.y);
  }
  activePointer = null;
});
canvas.addEventListener("pointercancel", () => { activePointer = null; });
canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const bounds = canvas.getBoundingClientRect();
  zoomAt(event.deltaY < 0 ? 1.13 : 1 / 1.13,
    event.clientX - bounds.left, event.clientY - bounds.top);
}, { passive: false });
canvas.addEventListener("keydown", (event) => {
  const arrow = {
    ArrowUp: [0, -1], ArrowDown: [0, 1],
    ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  }[event.key];
  if (arrow !== undefined) {
    event.preventDefault();
    navigateTo(
      clamp(selected.x + arrow[0], seed.bounds.minX, seed.bounds.maxX),
      clamp(selected.y + arrow[1], seed.bounds.minY, seed.bounds.maxY),
    );
  } else if (event.key === "+" || event.key === "=") {
    event.preventDefault(); zoomAt(1.35);
  } else if (event.key === "-") {
    event.preventDefault(); zoomAt(1 / 1.35);
  }
});

byId("previewForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const notice = byId("previewMessage");
  try {
    const char = normalizeGlyph(byId("postChar").value);
    const x = Number(byId("postX").value);
    const y = Number(byId("postY").value);
    const n = Number(byId("postN").value);
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !inside(x, y)) {
      throw new RangeError("座標は地図内の整数で指定してください。");
    }
    if (![1, 3, 5, 7].includes(n)) throw new RangeError("勢力値が不正です。");
    if (liveMode) activateDemo();
    previewPost = {
      userId: "local-preview-user", revision: 1,
      date: nextIsoDay(seed.date), x, y, char,
    };
    previewStrength = n;
    stopPlayback();
    buildHistory();
    frameIndex = 1;
    selected = { x, y };
    viewX = x;
    viewY = y;
    updatePanels();
    notice.textContent = "プレビュー更新済み（保存なし）。" +
      (n === 1 ? " 通常N=1は周囲へ拡大しません。" : "");
  } catch (error) {
    notice.textContent = error instanceof Error ? error.message : "入力エラー";
  }
});
byId("resetPreview").addEventListener("click", () => {
  stopPlayback();
  if (liveMode) activateDemo();
  previewPost = null;
  previewStrength = 1;
  frameIndex = 0;
  selected = { x: 0, y: 0 };
  viewX = 0;
  viewY = 0;
  buildHistory();
  updatePanels();
  byId("previewMessage").textContent = "デモを初期化しました。";
});

buildHistory();
const url = new URL(window.location.href);
const queryX = Number(url.searchParams.get("x"));
const queryY = Number(url.searchParams.get("y"));
if (url.searchParams.has("x") && url.searchParams.has("y") &&
    Number.isSafeInteger(queryX) && Number.isSafeInteger(queryY) && inside(queryX, queryY)) {
  selected = { x: queryX, y: queryY };
  viewX = queryX;
  viewY = queryY;
}
const dated = snapshots.findIndex((item) => item.date === url.searchParams.get("date"));
if (dated >= 0) frameIndex = dated;
byId("mapCanvas").addEventListener("contextmenu", (event) => event.preventDefault());
new ResizeObserver(renderSoon).observe(canvas);
updatePanels();


/**
 * When the local backend is available, present finalized DB snapshots alongside
 * the deterministic sandbox. Public snapshots contain only coordinates/char/N.
 * No authentication data is fetched by the map itself.
 */
function activateDemo() {
  stopPlayback();
  liveMode = false;
  snapshots = demoSnapshots;
  frameIndex = 0;
  byId("dayRange").max = String(snapshots.length - 1);
  const toggle = document.getElementById("toggleArchive");
  if (toggle) toggle.textContent = "公開アーカイブを見る";
  document.querySelector(".panel-label").textContent = "LIVE SIMULATION / LOCAL DEMO";
  updatePanels();
}
function activateArchive() {
  if (!archivedSnapshots || archivedSnapshots.length === 0) return;
  stopPlayback();
  liveMode = true;
  snapshots = archivedSnapshots;
  frameIndex = snapshots.length - 1;
  byId("dayRange").max = String(snapshots.length - 1);
  const toggle = document.getElementById("toggleArchive");
  if (toggle) toggle.textContent = "デモに戻る";
  document.querySelector(".panel-label").textContent = "PUBLISHED SNAPSHOTS / DEVELOPMENT DATABASE";
  byId("previewMessage").textContent =
    "公開アーカイブを閲覧中です。仮投稿するとデモ表示へ戻ります。";
  updatePanels();
}
async function findPublishedArchive() {
  try {
    const status = await fetch("./api/status", { credentials: "same-origin" });
    if (!status.ok || !status.headers.get("content-type")?.includes("application/json")) return;
    const historyResponse = await fetch("./api/history", { credentials: "same-origin" });
    if (!historyResponse.ok) return;
    const history = await historyResponse.json();
    const days = (history.days ?? []).slice(0, 21).reverse();
    const archived = [];
    for (const record of days) {
      const response = await fetch("./api/state?date=" + encodeURIComponent(record.day),
        { credentials: "same-origin" });
      if (!response.ok) return;
      const parsed = await response.json();
      const state = parsed.state;
      if (!state || !Array.isArray(state.cells) || !state.bounds) return;
      archived.push(state);
    }
    if (archived.length === 0) return;
    archivedSnapshots = archived;
    const button = document.createElement("button");
    button.type = "button";
    button.id = "toggleArchive";
    button.textContent = "公開アーカイブを見る";
    button.addEventListener("click", () => {
      if (liveMode) activateDemo();
      else activateArchive();
    });
    document.querySelector(".map-toolbar").append(button);
  } catch {
    // Static exports intentionally work without the optional HTTP backend.
  }
}
void findPublishedArchive();
