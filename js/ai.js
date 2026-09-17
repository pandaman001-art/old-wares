// 写真を AI に読ませる（任意機能）。
//
// 既定では使わない。利用者が自分の API キーを入れたときだけ有効になる。
// キーは端末の localStorage にだけ置き、写真は Google の API にだけ送る。
// 無料枠は送ったデータが学習に使われうるので、画面で明示して同意を取ること。
//
// 使わない場合はこれまでどおり ocr.js（Tesseract）が端末内で処理する。

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";

// モデル名は決め打ちにしない。提供側の都合で古い名前は新規キーに開放されなくなる。
// 実際に使えるモデルはキーごとに違うので listModels() で問い合わせ、pickBestModel() で選ぶ。
// これは一覧が取れなかったときの最後の手段でしかない。
export const FALLBACK_MODEL = "gemini-3.6-flash";

// 送る画像の大きさ。大きすぎても精度は上がらず、通信量と待ち時間が増えるだけ
const MAX_EDGE = 1400;
const QUALITY = 0.85;

const PROMPT = `これは衣類のタグの写真です。中古の衣類を検索するために、書かれている情報を読み取ってください。

- 写真が上下逆さま・横向きでも読んでください。
- text には読み取れた文字をすべて、書かれている順に改行区切りで入れてください。読めない部分は飛ばしてください。
- brand はブランド名。日本の中古販売サイトで使われる表記にしてください（例: THE NORTH FACE → ノースフェイス）。分からなければ空にしてください。
- model_numbers は品番・製品番号。英数字の並びやハイフン付きの番号（例: ND91841、331-359039）。複数あればすべて。
- sizes はサイズ表記（S / M / L / 100 / W32 など）。
- materials は素材（綿、ナイロン、ポリエステルなど）。
- made_in は生産国。
- 推測で埋めないでください。読み取れないものは空にしてください。`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    brand: { type: "string" },
    model_numbers: { type: "array", items: { type: "string" } },
    sizes: { type: "array", items: { type: "string" } },
    materials: { type: "array", items: { type: "string" } },
    made_in: { type: "string" },
  },
  required: ["text"],
};

/** 送信用に縮小した JPEG の base64（データ URL の前置きは外す）。 */
async function toBase64Jpeg(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", QUALITY).split(",")[1];
}

/** API の失敗を、画面にそのまま出せる日本語にする。 */
function describeError(status, payload) {
  const message = payload?.error?.message || "";
  if (status === 400 && /API key/i.test(message)) {
    return "このキーは受け付けられませんでした。Google AI Studio の「Create API key」で出る文字列か確認してください"
      + "（プロジェクト ID やクライアント シークレットでは動きません）。";
  }
  if (status === 403) return "API キーにこのモデルを使う権限がありません。";
  if (/no longer available|not found|not supported|is not available/i.test(message)) {
    return "このモデルは使えなくなっています。「保存して接続を確認」を押して、"
      + "一覧から別のモデルを選び直してください。";
  }
  if (status === 429) return "無料枠の上限に達しました。しばらく待つか、端末内の読み取りを使ってください。";
  if (status >= 500) return "相手側のサーバーが混み合っています。少し待って試してください。";
  return `読み取りに失敗しました（${status}）${message ? ": " + message : ""}`;
}

async function callApi(path, { apiKey, method = "GET", body, signal }) {
  const response = await fetch(`${ENDPOINT}${path}?key=${encodeURIComponent(apiKey)}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // 本文が JSON でないことがある（502 の HTML など）
  }
  if (!response.ok) throw new Error(describeError(response.status, payload));
  return payload;
}

/**
 * 使えるモデルの中から、この用途に向いたものを選ぶ。
 * タグを読むだけなので速くて安い flash 系を優先し、予告なく消える preview 系は避ける。
 * 版が新しいほど良いものとして扱う。
 */
export function pickBestModel(names) {
  const rank = (name) => {
    const version = Number.parseFloat((name.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] ?? "0");
    const tier = /flash-lite/.test(name) ? 1 : /flash/.test(name) ? 3 : /pro/.test(name) ? 2 : 0;
    const stable = /preview|exp|latest|thinking/.test(name) ? 0 : 1;
    return [stable, tier, version];
  };
  return [...(names || [])].sort((a, b) => {
    const [as, at, av] = rank(a);
    const [bs, bt, bv] = rank(b);
    return bs - as || bt - at || bv - av || a.localeCompare(b);
  })[0] || null;
}

/** キーで使えるモデルのうち、画像を読めるものを返す。 */
export async function listModels(apiKey) {
  const payload = await callApi("/models", { apiKey });
  return (payload?.models || [])
    .filter((model) => (model.supportedGenerationMethods || []).includes("generateContent"))
    .map((model) => model.name.replace(/^models\//, ""))
    // 画像を扱えない実験用や埋め込み専用のものを落とす
    .filter((name) => !/embedding|aqa|imagen|veo|tts|live/.test(name))
    .sort();
}

/** 送信するリクエストの中身。テストから確かめられるよう切り出してある。 */
export function buildRequest(base64Jpeg) {
  return {
    contents: [
      {
        parts: [
          { inlineData: { mimeType: "image/jpeg", data: base64Jpeg } },
          { text: PROMPT },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  };
}

/** API の返事を、このアプリで使う形にそろえる。 */
export function parseResponse(payload) {
  const candidate = payload?.candidates?.[0];
  const blockReason = payload?.promptFeedback?.blockReason;
  if (blockReason) throw new Error(`写真が受け付けられませんでした（${blockReason}）。`);
  const text = (candidate?.content?.parts || []).map((part) => part.text || "").join("");
  if (!text.trim()) throw new Error("読み取り結果が空でした。もう一度撮り直してください。");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 構造化に失敗しても、本文が読めていれば検索語には使える
    return { text: text.trim(), hint: {} };
  }
  return {
    text: (parsed.text || "").trim(),
    hint: {
      brand: (parsed.brand || "").trim() || null,
      modelNumbers: (parsed.model_numbers || []).map((s) => String(s).trim()).filter(Boolean),
      sizes: (parsed.sizes || []).map((s) => String(s).trim()).filter(Boolean),
      materials: (parsed.materials || []).map((s) => String(s).trim()).filter(Boolean),
      madeIn: (parsed.made_in || "").trim() || null,
    },
  };
}

/** 写真を送って、タグに書かれている内容を読み取る。 */
export async function readTagWithAi(blob, { apiKey, model = FALLBACK_MODEL, signal } = {}) {
  if (!apiKey) throw new Error("API キーが設定されていません。");
  const base64 = await toBase64Jpeg(blob);
  const payload = await callApi(`/models/${encodeURIComponent(model)}:generateContent`, {
    apiKey,
    method: "POST",
    body: buildRequest(base64),
    signal,
  });
  return parseResponse(payload);
}
