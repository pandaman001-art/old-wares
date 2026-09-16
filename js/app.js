// 画面の組み立てとイベント配線。

import { DEFAULT_MODEL, listModels, readTagWithAi } from "./ai.js";
import { barcodeSupported, describeBarcode, detectFromVideo } from "./barcode.js";
import { cameraSupported, startCamera, takePhoto } from "./camera.js";
import { drawHistogram, SERIES_VARS } from "./chart.js";
import { buildQueries, identify } from "./identify.js";
import { readTextFromImage, SHAKY_CONFIDENCE } from "./ocr.js";
import { cropImage, shrinkImage } from "./photo.js";
import { DEFAULT_GROUPS, quote, searchPageUrl } from "./quote.js";
import {
  deleteRecord, getRecord, listRecords, loadAiSettings, loadDraft,
  saveAiSettings, saveDraft, saveRecord,
} from "./store.js";

// 更新が届いたかを画面で確認できるようにする。上げるときは sw.js の CACHE も揃えること
const APP_VERSION = "v9";

const el = (id) => document.getElementById(id);
const yen = (n) => (n === null || n === undefined ? "—" : "¥" + Number(n).toLocaleString("ja-JP"));
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let latest = null;
let sortKey = "price";
let sortDir = 1;
// 商品特定の作業状態。写真は記録用、バーコードとタグ文字が検索語のもとになる
let photoBlob = null;
// OCR は縮小前の写真のほうがよく読めるので、元のまま持っておく（保存はしない）
let photoOriginal = null;
let photoUrl = null;
// 読み取る範囲（写真に対する 0-1 の比率）。指でなぞって決める
let cropRect = null;
// AI が読み取った構造化結果。あれば検索語の組み立てで優先する
let aiHint = {};
let barcodeValue = "";

/* ---------- テーマ ---------- */
el("theme-toggle").addEventListener("click", () => {
  const root = document.documentElement;
  const dark =
    root.getAttribute("data-theme") === "dark" ||
    (!root.hasAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
  root.setAttribute("data-theme", dark ? "light" : "dark");
  if (latest) drawHistogram(latest, el("hist"), el("tip"), el("legend"));
});

/* ---------- 1. 商品を特定する ---------- */
const TAG_SAMPLE = `THE NORTH FACE
ND91841
ヌプシ ジャケット
SIZE: L
表地 ナイロン100%
中わた ダウン90%
MADE IN CHINA`;

el("photo-pick").addEventListener("click", () => el("photo").click());

// 端末のカメラアプリを呼ばず、映像の 1 フレームを切り出す。
// カメラアプリを起動しないのでシャッター音が鳴らない
if (cameraSupported()) el("photo-camera").hidden = false;

let camera = null;
let shutter = null;

async function openCamera(mode) {
  el("scan-hint").textContent =
    mode === "photo"
      ? "写したいものを画面に収めて「撮る」を押してください（シャッター音は鳴りません）"
      : "バーコードを画面に収めてください";
  el("shutter").hidden = mode !== "photo";
  el("scanner").hidden = false;
  camera = await startCamera(el("scan-video"));
}

function closeCamera() {
  camera?.stop();
  camera = null;
  shutter = null;
  el("scanner").hidden = true;
  el("shutter").hidden = true;
}

el("photo-camera").addEventListener("click", async () => {
  scanController = new AbortController();
  try {
    await openCamera("photo");
    const frame = await new Promise((resolve, reject) => {
      shutter = resolve;
      scanController.signal.addEventListener("abort", () => reject(new Error("撮影を中止しました")));
    });
    photoOriginal = frame;
    photoBlob = await shrinkImage(frame);
    showPhoto();
    el("barcode-status").className = "status";
    el("barcode-status").textContent = "";
  } catch (error) {
    el("barcode-status").className = "status";
    el("barcode-status").textContent = /中止/.test(error.message) ? "" : error.message;
  } finally {
    closeCamera();
    scanController = null;
  }
});

el("shutter").addEventListener("click", async () => {
  if (!shutter) return;
  try {
    shutter(await takePhoto(el("scan-video"), camera?.stream));
  } catch {
    el("scan-hint").textContent = "まだ映像が来ていません。少し待ってからもう一度押してください。";
  }
});

el("photo").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  photoOriginal = file;
  photoBlob = await shrinkImage(file);
  showPhoto();
  event.target.value = "";   // 同じ写真をもう一度選べるようにする
});

el("photo-clear").addEventListener("click", () => {
  photoBlob = null;
  photoOriginal = null;
  el("ocr-status").textContent = "";
  showPhoto();
});

function showPhoto() {
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = photoBlob ? URL.createObjectURL(photoBlob) : null;
  el("photo-preview").src = photoUrl || "";
  el("photo-wrap").hidden = !photoBlob;
  el("photo-hint").hidden = !photoBlob;
  el("photo-clear").hidden = !photoBlob;
  el("ocr-actions").hidden = !photoBlob;
  clearCrop();
}

/* ---------- 読み取る範囲を指でなぞって決める ---------- */
function clearCrop() {
  cropRect = null;
  el("crop-box").hidden = true;
  el("crop-clear").hidden = true;
}

el("crop-clear").addEventListener("click", clearCrop);

(function setupCrop() {
  const wrap = el("photo-wrap");
  const box = el("crop-box");
  let origin = null;

  const place = (event) => {
    const bounds = el("photo-preview").getBoundingClientRect();
    const x = Math.min(Math.max(0, event.clientX - bounds.left), bounds.width);
    const y = Math.min(Math.max(0, event.clientY - bounds.top), bounds.height);
    const left = Math.min(origin.x, x);
    const top = Math.min(origin.y, y);
    const width = Math.abs(x - origin.x);
    const height = Math.abs(y - origin.y);
    Object.assign(box.style, {
      left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`,
    });
    box.hidden = false;
    return { left, top, width, height, bounds };
  };

  wrap.addEventListener("pointerdown", (event) => {
    if (!photoBlob) return;
    const bounds = el("photo-preview").getBoundingClientRect();
    origin = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    wrap.setPointerCapture(event.pointerId);
    // 指でなぞる間にページが動かないようにする
    event.preventDefault();
  });

  wrap.addEventListener("pointermove", (event) => {
    if (origin) place(event);
  });

  wrap.addEventListener("pointerup", (event) => {
    if (!origin) return;
    const { left, top, width, height, bounds } = place(event);
    origin = null;
    // 指が滑っただけの小さい範囲は無視する
    if (width < 16 || height < 16) {
      clearCrop();
      return;
    }
    cropRect = {
      x: left / bounds.width, y: top / bounds.height,
      w: width / bounds.width, h: height / bounds.height,
    };
    el("crop-clear").hidden = false;
  });
})();

// 写真から文字を読む。エンジンは同梱してあり、最初に押したときだけ読み込む
const OCR_STEPS = {
  "loading tesseract core": "読み取りエンジンを準備中",
  "initializing tesseract": "読み取りエンジンを準備中",
  "loading language traineddata": "文字データを読み込み中",
  "initializing api": "準備中",
  "checking orientation": "向きを調べています",
  "recognizing text": "文字を読み取り中",
};

/* ---------- AI で読む（任意・API キーが必要） ---------- */
// キーで使えると分かったモデル。接続確認で取得するまでは既定だけ
let availableModels = [];

function aiSettings() {
  return loadAiSettings() || {};
}

function refreshAiUi() {
  const { apiKey, model } = aiSettings();
  el("ai-read").hidden = !apiKey;
  el("ai-forget").hidden = !apiKey;
  el("ai-summary").textContent = apiKey
    ? `AI で読む（設定済み・${model || DEFAULT_MODEL}）`
    : "AI で読む（任意・API キーが必要）";
  if (apiKey && !el("ai-key").value) el("ai-key").value = apiKey;
  // 取得済みの一覧があればそれを保つ。保存のたびに候補が 1 つへ潰れないように
  setModelOptions(availableModels, model || DEFAULT_MODEL);
}

function setModelOptions(names, selected) {
  const select = el("ai-model");
  const options = [...new Set([...names, selected, DEFAULT_MODEL].filter(Boolean))];
  select.innerHTML = options.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
  select.value = options.includes(selected) ? selected : options[0];
}

el("ai-save").addEventListener("click", async () => {
  const apiKey = el("ai-key").value.trim();
  const status = el("ai-status");
  if (!apiKey) {
    status.className = "status bad";
    status.textContent = "API キーを入れてください。";
    return;
  }
  status.className = "status";
  status.textContent = "接続を確認しています…";
  try {
    // キーが本当に使えるか、モデル一覧を取って確かめる
    const models = await listModels(apiKey);
    if (!models.length) throw new Error("このキーで使えるモデルが見つかりませんでした。");
    availableModels = models;
    setModelOptions(models, models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : models[0]);
    saveAiSettings({ apiKey, model: el("ai-model").value });
    refreshAiUi();
    status.className = "status ok";
    status.textContent = `使えます。${models.length} 個のモデルが見つかりました。`;
  } catch (error) {
    status.className = "status bad";
    status.textContent = error.message;
  }
});

el("ai-model").addEventListener("change", () => {
  const { apiKey } = aiSettings();
  if (apiKey) {
    saveAiSettings({ apiKey, model: el("ai-model").value });
    refreshAiUi();
  }
});

el("ai-forget").addEventListener("click", () => {
  saveAiSettings({});
  el("ai-key").value = "";
  el("ai-status").className = "status";
  el("ai-status").textContent = "キーを削除しました。以降は端末内だけで処理します。";
  refreshAiUi();
});

el("ai-read").addEventListener("click", async () => {
  if (!photoBlob) return;
  const { apiKey, model } = aiSettings();
  const button = el("ai-read");
  const status = el("ocr-status");
  button.disabled = true;
  status.className = "status";
  status.textContent = "AI が読み取っています…";
  try {
    const source = await cropImage(photoOriginal || photoBlob, cropRect);
    const { text, hint } = await readTagWithAi(source, { apiKey, model });
    aiHint = hint || {};
    const current = el("tag-text").value.trim();
    el("tag-text").value = current ? `${current}\n${text}` : text;
    persistDraft();
    status.className = "status ok";
    status.textContent = `AI が ${text.split("\n").filter(Boolean).length} 行読み取りました。間違いは下の欄で直せます。`;
    runIdentify();
  } catch (error) {
    status.className = "status bad";
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

el("ocr").addEventListener("click", async () => {
  if (!photoBlob) return;
  const button = el("ocr");
  const status = el("ocr-status");
  button.disabled = true;
  status.className = "status";
  status.textContent = "準備中…（初回は少し時間がかかります）";
  try {
    // 範囲が指定されていればそこだけを切り出す。元の大きい写真から切るほど細かく読める
    const source = await cropImage(photoOriginal || photoBlob, cropRect);
    aiHint = {};
    const { text, confidence } = await readTextFromImage(source, {
      japanese: el("ocr-jp").checked,
      onProgress: (message) => {
        const label = OCR_STEPS[message.status];
        if (label) {
          const percent = Math.round((message.progress || 0) * 100);
          status.textContent = `${label}… ${percent}%`;
        }
      },
    });
    if (!text) {
      status.className = "status bad";
      status.textContent = cropRect
        ? "文字を読み取れませんでした。範囲をタグの文字だけに絞るか、もっと近づいて撮り直してください。"
        : "文字を読み取れませんでした。タグの部分を指でなぞって囲むと読めることがあります。";
      return;
    }
    const current = el("tag-text").value.trim();
    el("tag-text").value = current ? `${current}
${text}` : text;
    persistDraft();
    const shaky = confidence < SHAKY_CONFIDENCE;
    status.className = shaky ? "status" : "status ok";
    status.textContent = shaky
      ? `${text.split("\n").length} 行読み取りましたが、はっきり読めていません（${confidence}%）。下の欄で確かめてください。`
      : `${text.split("\n").length} 行読み取りました。間違いは下の欄で直せます。`;
    runIdentify();
  } catch (error) {
    status.className = "status bad";
    status.textContent = `読み取りに失敗しました: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

// バーコード読み取りは対応端末でだけ出す（iOS の Safari には標準機能が無い）
if (barcodeSupported()) el("scan").hidden = false;

let scanController = null;

el("scan").addEventListener("click", async () => {
  scanController = new AbortController();
  try {
    await openCamera("barcode");
    barcodeValue = await detectFromVideo(el("scan-video"), scanController.signal);
    showBarcodeStatus();
    runIdentify();
  } catch (error) {
    el("barcode-status").className = "status";
    el("barcode-status").textContent = /中止/.test(error.message) ? "" : error.message;
  } finally {
    closeCamera();
    scanController = null;
  }
});

el("scan-cancel").addEventListener("click", () => scanController?.abort());

function showBarcodeStatus() {
  const status = el("barcode-status");
  if (!barcodeValue) {
    status.className = "status";
    status.textContent = "";
    return;
  }
  const info = describeBarcode(barcodeValue);
  status.className = "status ok";
  status.textContent =
    `バーコード ${info.code}（${info.kind}${info.country ? " / " + info.country : ""}` +
    `${info.valid ? "" : " / チェックディジットが合いません"}）`;
}

el("identify-sample").addEventListener("click", () => {
  el("tag-text").value = TAG_SAMPLE;
  runIdentify();
});

el("identify").addEventListener("click", runIdentify);
// スマホでは検索ページを見に行って戻る操作が中心なので、打った端から退避する
el("tag-text").addEventListener("input", persistDraft);

function runIdentify() {
  const tagText = el("tag-text").value;
  // 案内は押したボタンのすぐ下に出す。ページ末尾に出すと画面外になり、
  // 「押しても反応しない」ようにしか見えない
  if (!tagText.trim() && !barcodeValue) {
    el("identify-status").textContent =
      "タグに書かれている文字を入れるか、バーコードを読み取ってください。";
    el("tag-text").focus();
    return;
  }
  el("identify-status").textContent = "";
  const found = identify(tagText, aiHint);
  const queries = buildQueries(found, { barcode: barcodeValue, note: el("q").value });

  const chips = [
    ["ブランド", found.brand ? found.brand.canonical : null],
    ["品番", found.modelNumbers.join(" / ")],
    ["サイズ", found.sizes.join(" / ")],
    ["産地", found.madeIn],
    ["素材", found.materials.join(" / ")],
    ["バーコード", barcodeValue],
  ].filter(([, value]) => value);

  el("chips").innerHTML = chips.length
    ? chips.map(([k, v]) => `<span class="chip"><span class="k">${k}</span><b>${escapeHtml(v)}</b></span>`).join("")
    : `<span class="muted" style="font-size:13px">ブランドや品番は読み取れませんでした。書かれている言葉をそのまま検索語に使います。</span>`;

  el("queries").innerHTML = queries.length
    ? queries
        .map(
          (q) => `<button type="button" data-query="${escapeHtml(q.query)}">
            <span class="qtext">${escapeHtml(q.query)}</span><span class="qlabel">${escapeHtml(q.label)}</span>
          </button>`
        )
        .join("")
    : `<span class="muted" style="font-size:13px">検索語を作れませんでした。</span>`;

  document.querySelectorAll("[data-query]").forEach((button) =>
    button.addEventListener("click", () => {
      el("q").value = button.dataset.query;
      persistDraft();
      el("q").scrollIntoView({ behavior: "smooth", block: "center" });
    })
  );
  el("identify-result").hidden = false;
}

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
    tagText: el("tag-text").value,
    barcode: barcodeValue,
    texts: Object.fromEntries(DEFAULT_GROUPS.map((g) => [g.key, el("text-" + g.key).value])),
  });
}

function restoreDraft() {
  const draft = loadDraft();
  if (!draft) return;
  el("q").value = draft.q || "";
  el("tag-text").value = draft.tagText || "";
  barcodeValue = draft.barcode || "";
  for (const g of DEFAULT_GROUPS) {
    const area = el("text-" + g.key);
    if (area && draft.texts?.[g.key]) {
      area.value = draft.texts[g.key];
      updatePasteHint(area);
    }
  }
  // 前回の識別結果をそのまま見られるように組み立て直す
  if (el("tag-text").value.trim() || barcodeValue) {
    showBarcodeStatus();
    runIdentify();
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
  barcodeValue = "";
  aiHint = {};
  photoBlob = null;
  photoOriginal = null;
  el("ocr-status").textContent = "";
  showPhoto();
  el("tag-text").value = "";
  el("barcode-status").textContent = "";
  el("identify-status").textContent = "";
  el("chips").innerHTML = "";
  el("queries").innerHTML = "";
  el("identify-result").hidden = true;
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
  // 出しただけでは画面外のことがあるので、見える位置まで寄せる
  if (list.length) box.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
      photo: photoBlob,
      tagText: el("tag-text").value,
      barcode: barcodeValue,
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

let thumbUrls = [];

async function refreshRecords() {
  // 前回作ったサムネイルの URL を解放してから作り直す
  thumbUrls.forEach((url) => URL.revokeObjectURL(url));
  thumbUrls = [];
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
      ${r.photo ? `<img class="thumb" src="${trackThumb(r.photo)}" alt="">` : ""}
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

function trackThumb(blob) {
  const url = URL.createObjectURL(blob);
  thumbUrls.push(url);
  return url;
}

async function openRecord(id) {
  const record = await getRecord(id);
  if (!record) return showMessages(["保存した調査を開けませんでした。"]);
  el("q").value = record.query || "";
  el("tag-text").value = record.tagText || "";
  barcodeValue = record.barcode || "";
  photoBlob = record.photo || null;
  photoOriginal = null;
  aiHint = {};
  el("ocr-status").textContent = "";
  showPhoto();
  showBarcodeStatus();
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
el("version").textContent = APP_VERSION;
refreshAiUi();
renderPanes();
restoreDraft();
showPhoto();
el("q").addEventListener("input", persistDraft);
refreshRecords();

if ("serviceWorker" in navigator) {
  // Service Worker が新しい版に入れ替わったら一度だけ読み込み直す。
  // 古い JS と新しい HTML が混ざって「ボタンが効かない」状態になるのを防ぐ
  let reloading = false;
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  }
  // オフラインでも開けるよう、アプリ本体をキャッシュする
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
