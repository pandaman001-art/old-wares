// 画面の組み立てとイベント配線。

import { drawHistogram, SERIES_VARS } from "./chart.js";
import { DEFAULT_GROUPS, quote, searchPageUrl } from "./quote.js";
import { deleteRecord, getRecord, listRecords, loadDraft, saveDraft, saveRecord } from "./store.js";

const el = (id) => document.getElementById(id);
const yen = (n) => (n === null || n === undefined ? "—" : "¥" + Number(n).toLocaleString("ja-JP"));
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let latest = null;
let sortKey = "price";
let sortDir = 1;

/* ---------- テーマ ---------- */
el("theme-toggle").addEventListener("click", () => {
  const root = document.documentElement;
  const dark =
    root.getAttribute("data-theme") === "dark" ||
    (!root.hasAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
  root.setAttribute("data-theme", dark ? "light" : "dark");
  if (latest) drawHistogram(latest, el("hist"), el("tip"), el("legend"));
});

/* ---------- 入力欄 ---------- */
const canPaste = typeof navigator.clipboard?.readText === "function";

function renderPanes() {
  el("panes").innerHTML = DEFAULT_GROUPS.map(
    (g, i) => `
    <div class="pane">
      <h3><span class="swatch" style="background:var(${SERIES_VARS[i % 2]})"></span>${escapeHtml(g.label)}</h3>
      <div class="pane-actions">
        <button type="button" class="ghost small" data-open="${g.key}">検索ページを開く ↗</button>
        ${canPaste ? `<button type="button" class="ghost small" data-paste="${g.key}">貼り付け</button>` : ""}
      </div>
      <textarea id="text-${g.key}" placeholder="検索結果をコピーしてここに貼り付け"
        autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
      <div class="status" id="status-${g.key}"></div>
    </div>`
  ).join("");

  document.querySelectorAll("[data-open]").forEach((button) =>
    button.addEventListener("click", () => openSearchPage(button.dataset.open))
  );
  document.querySelectorAll("[data-paste]").forEach((button) =>
    button.addEventListener("click", () => pasteInto(button.dataset.paste))
  );
  document.querySelectorAll(".pane textarea").forEach((area) =>
    area.addEventListener("input", () => {
      updatePasteHint(area);
      persistDraft();
    })
  );
}

function updatePasteHint(area) {
  const key = area.id.replace("text-", "");
  const lines = area.value.split("\n").filter((l) => l.trim()).length;
  const status = el("status-" + key);
  status.className = "status";
  status.textContent = lines ? `${lines} 行 貼り付け済み` : "";
}

function openSearchPage(key) {
  const query = el("q").value.trim();
  if (!query) {
    el("q").focus();
    showMessages(["先に調べたい服の名前を入れてください。"]);
    return;
  }
  window.open(searchPageUrl(key, query), "_blank", "noopener");
}

async function pasteInto(key) {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) return showMessages(["クリップボードが空です。検索結果をコピーしてください。"]);
    const area = el("text-" + key);
    area.value = text;
    updatePasteHint(area);
    persistDraft();
    showMessages([]);
  } catch {
    showMessages(["クリップボードを読めませんでした。枠を長押しして手で貼り付けてください。"]);
  }
}

/* ---------- 下書き（この端末のブラウザのみ） ---------- */
function persistDraft() {
  saveDraft({
    q: el("q").value,
    texts: Object.fromEntries(DEFAULT_GROUPS.map((g) => [g.key, el("text-" + g.key).value])),
  });
}

function restoreDraft() {
  const draft = loadDraft();
  if (!draft) return;
  el("q").value = draft.q || "";
  for (const g of DEFAULT_GROUPS) {
    const area = el("text-" + g.key);
    if (area && draft.texts?.[g.key]) {
      area.value = draft.texts[g.key];
      updatePasteHint(area);
    }
  }
}

/* ---------- 計算 ---------- */
function currentGroups() {
  return DEFAULT_GROUPS.map((g) => ({ key: g.key, label: g.label, text: el("text-" + g.key).value }));
}

function currentOptions() {
  return {
    priceMin: el("price_min").value ? Number(el("price_min").value) : null,
    priceMax: el("price_max").value ? Number(el("price_max").value) : null,
    excludeWords: el("exclude").value.split(",").map((s) => s.trim()).filter(Boolean),
    useDefaultExcludes: el("default_excludes").checked,
    removeOutliers: el("remove_outliers").checked,
  };
}

function calculate() {
  const groups = currentGroups();
  if (!groups.some((g) => g.text.trim())) {
    showMessages(["検索結果をコピーして、どちらかの枠に貼り付けてください。"]);
    return;
  }
  const options = currentOptions();
  if (options.priceMin !== null && options.priceMax !== null && options.priceMin > options.priceMax) {
    showMessages(["下限価格が上限価格を超えています。"]);
    return;
  }
  latest = quote(el("q").value, groups, options);
  render(latest);
  el("save-status").textContent = "";
  persistDraft();
}

el("calc").addEventListener("click", calculate);

el("clear").addEventListener("click", () => {
  for (const g of DEFAULT_GROUPS) {
    el("text-" + g.key).value = "";
    el("status-" + g.key).textContent = "";
  }
  latest = null;
  for (const id of ["summary", "source-cards", "chart-card", "table-card"]) el(id).hidden = true;
  showMessages([]);
  persistDraft();
});

el("sample").addEventListener("click", () => {
  el("q").value = "ノースフェイス ヌプシ 700";
  const yahoo = [
    ["THE NORTH FACE ヌプシ 700 ダウンジャケット L ブラック", 18500],
    ["ノースフェイス ヌプシ 700 M 90年代", 14800], ["ノースフェイス ヌプシ 700 ダウン S", 9800],
    ["THE NORTH FACE ヌプシ 700 XL グレー", 21000], ["ノースフェイス ヌプシ 700 L 美品", 16800],
    ["ノースフェイス ヌプシ 700 M", 12500], ["ノースフェイス ヌプシ ダウン まとめ売り 3点", 24000],
    ["THE NORTH FACE ヌプシ 700 S イエロー", 13200], ["ノースフェイス ヌプシ 700 L", 15500],
    ["ノースフェイス ヌプシ 700 M ネイビー", 11800],
  ]
    .map(([t, p]) => `${t}\n即決 ${Math.round(p * 1.6).toLocaleString()}円\n落札 ${p.toLocaleString()}円\n2026年8月20日`)
    .join("\n");
  const mercari = [
    ["ノースフェイス ヌプシ 700 Lサイズ", 19800], ["THE NORTH FACE ヌプシ700 M", 17500],
    ["ノースフェイス ヌプシ 700 ダウンジャケット S", 14000], ["ノースフェイス ヌプシ 700 XL", 23800],
    ["THE NORTH FACE ヌプシ 700 L 美品", 21500], ["ノースフェイス ヌプシ700 M ブラック", 18800],
    ["ノースフェイス ヌプシ 700 S ジャンク 破損あり", 4500], ["ノースフェイス ヌプシ 700 L", 20000],
  ]
    .map(([t, p]) => `¥${p.toLocaleString()}\n${t}\n送料込み\nSOLD`)
    .join("\n");
  el("text-yahoo").value = yahoo;
  el("text-mercari").value = mercari;
  document.querySelectorAll(".pane textarea").forEach(updatePasteHint);
  calculate();
});

function showMessages(list) {
  const box = el("messages");
  box.innerHTML = list.map((m) => `<div class="card banner">${escapeHtml(m)}</div>`).join("");
  box.hidden = list.length === 0;
}

/* ---------- 描画 ---------- */
function render(result) {
  showMessages(result.warnings);
  const { combined, blend } = result;
  const has = combined.count > 0;

  el("summary").hidden = !has;
  el("chart-card").hidden = !has;
  el("source-cards").hidden = false;
  el("table-card").hidden = !result.sources.some((s) => s.listings.length);

  if (has) {
    el("hero").textContent = yen(blend.equalWeightMedian ?? combined.median);
    el("hero-sub").textContent =
      `よくある価格帯 ${yen(combined.p25)} 〜 ${yen(combined.p75)}（全 ${combined.count} 件の中央 50%）`;
    el("tiles").innerHTML = [
      ["全件の中央値", yen(combined.median)],
      ["全件の平均", yen(blend.weightedMean ?? combined.mean)],
      ["有効データ", combined.count + " 件"],
      ["最安 / 最高", `${yen(combined.min)} / ${yen(combined.max)}`],
    ]
      .map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div></div>`)
      .join("");
  }

  for (const source of result.sources) {
    const status = el("status-" + source.source);
    if (!status) continue;
    if (source.error) {
      status.className = "status bad";
      status.textContent = source.error;
    } else if (source.parse.pricesFound) {
      status.className = "status ok";
      status.textContent = `価格 ${source.parse.pricesFound} 件を読み取り（統計に使用 ${source.stats.count} 件）`;
    }
  }

  renderSources(result);
  if (has) drawHistogram(result, el("hist"), el("tip"), el("legend"));
  renderTable(result);
}

function renderSources(result) {
  el("sources").innerHTML = result.sources
    .map((s, i) => {
      const head = `<h3><span class="swatch" style="background:var(${SERIES_VARS[i % 2]})"></span>${escapeHtml(s.label)}</h3>`;
      if (s.error) return `<div class="src failed">${head}<div class="err">${escapeHtml(s.error)}</div></div>`;
      if (!s.stats.count) return `<div class="src">${head}<div class="note">入力なし</div></div>`;
      return `<div class="src">${head}
        <dl>
          <dt>中央値</dt><dd>${yen(s.stats.median)}</dd>
          <dt>平均</dt><dd>${yen(s.stats.mean)}</dd>
          <dt>価格帯 (25–75%)</dt><dd>${yen(s.stats.p25)} 〜 ${yen(s.stats.p75)}</dd>
          <dt>有効 / 読み取り</dt><dd>${s.stats.count} / ${s.listings.length} 件</dd>
        </dl>
        <div class="note">除外 ${s.excludedCount - s.outlierCount} 件・外れ値 ${s.outlierCount} 件${
          s.parse.untitled ? `・商品名なし ${s.parse.untitled} 件` : ""
        }</div>
      </div>`;
    })
    .join("");
}

/* ---------- 明細テーブル ---------- */
function rowsOf(result, includeExcluded) {
  const labels = Object.fromEntries(result.sources.map((s) => [s.source, s.label]));
  const rows = result.sources.flatMap((s) => s.listings.map((x) => ({ ...x, label: labels[s.source] })));
  return includeExcluded ? rows : rows.filter((x) => !x.excluded);
}

function renderTable(result) {
  const rows = rowsOf(result, el("show-excluded").checked);
  rows.sort((a, b) => {
    const av = a[sortKey] ?? "";
    const bv = b[sortKey] ?? "";
    return (av > bv ? 1 : av < bv ? -1 : 0) * sortDir;
  });
  document.querySelector("#table tbody").innerHTML = rows
    .slice(0, 500)
    .map(
      (x) => `<tr class="${x.excluded ? "out" : ""}">
      <td>${escapeHtml(x.label || x.source)}</td>
      <td class="title">${escapeHtml(x.title || "（商品名なし）")}</td>
      <td class="num">${yen(x.price)}</td>
      <td>${x.excluded ? `<span class="tag">${escapeHtml(x.excludeReason || "除外")}</span>` : "使用"}</td>
    </tr>`
    )
    .join("");
  el("table-note").textContent =
    `${rows.length} 件を表示${rows.length > 500 ? "（先頭 500 件まで）" : ""}。灰色の行は統計から除外した明細です。`;
}

el("show-excluded").addEventListener("change", () => latest && renderTable(latest));
document.querySelectorAll("#table th[data-sort]").forEach((th) =>
  th.addEventListener("click", () => {
    sortDir = th.dataset.sort === sortKey ? -sortDir : 1;
    sortKey = th.dataset.sort;
    if (latest) renderTable(latest);
  })
);

/* ---------- CSV ---------- */
el("csv").addEventListener("click", () => {
  if (!latest) return;
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["入力元", "商品名", "価格", "統計に使用", "除外理由"].map(cell).join(",")];
  for (const row of rowsOf(latest, true)) {
    lines.push([row.label, row.title, row.price, row.excluded ? "no" : "yes", row.excludeReason || ""].map(cell).join(","));
  }
  // Excel で文字化けしないよう BOM 付きにする
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), {
    href: url,
    download: `oldwares-${latest.query || "result"}.csv`,
  });
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
});

/* ---------- 保存した調査 ---------- */
el("save").addEventListener("click", async () => {
  if (!latest) return;
  try {
    await saveRecord({
      query: latest.query,
      groups: currentGroups(),
      summary: {
        blend: latest.blend,
        combined: latest.combined,
        perSource: latest.sources.map((s) => ({ source: s.source, label: s.label, median: s.stats.median, count: s.stats.count })),
      },
    });
    el("save-status").textContent = "保存しました";
    await refreshRecords();
  } catch {
    el("save-status").textContent = "保存に失敗しました";
  }
});

async function refreshRecords() {
  let records = [];
  try {
    records = await listRecords(20);
  } catch {
    // IndexedDB が使えない環境（プライベートウィンドウ等）では保存機能だけ無効になる
  }
  el("records-card").hidden = !records.length;
  el("records").innerHTML = records
    .map(
      (r) => `<li>
      <span class="q">${escapeHtml(r.query || "(名前なし)")}</span>
      <span class="val">${yen(r.summary?.blend?.equalWeightMedian)}</span>
      <span class="when">${new Date(r.createdAt).toLocaleString("ja-JP")}</span>
      <span class="spacer"></span>
      <button type="button" class="link" data-load="${r.id}">開く</button>
      <button type="button" class="link" data-del="${r.id}">削除</button>
    </li>`
    )
    .join("");
  document.querySelectorAll("[data-load]").forEach((b) => b.addEventListener("click", () => openRecord(b.dataset.load)));
  document.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => removeRecord(b.dataset.del)));
}

async function openRecord(id) {
  const record = await getRecord(id);
  if (!record) return showMessages(["保存した調査を開けませんでした。"]);
  el("q").value = record.query || "";
  for (const g of DEFAULT_GROUPS) el("text-" + g.key).value = "";
  for (const g of record.groups || []) {
    const area = el("text-" + g.key);
    if (area) {
      area.value = g.text || "";
      updatePasteHint(area);
    }
  }
  calculate();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function removeRecord(id) {
  if (!confirm("この保存を削除しますか？")) return;
  await deleteRecord(id);
  await refreshRecords();
}

// 幅が変わるとチャートの viewBox を取り直す必要がある
let resizeTimer = null;
window.addEventListener("resize", () => {
  if (!latest) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => drawHistogram(latest, el("hist"), el("tip"), el("legend")), 150);
});

/* ---------- 起動 ---------- */
renderPanes();
restoreDraft();
el("q").addEventListener("input", persistDraft);
refreshRecords();

if ("serviceWorker" in navigator) {
  // オフラインでも開けるよう、アプリ本体をキャッシュする
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
