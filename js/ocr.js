// 写真からタグの文字を読む（OCR）。
//
// 写真は端末の外に出さない。OCR エンジン（Tesseract）は vendor/ に同梱してあり、
// 「写真から文字を読む」を最初に押したときだけ読み込む。基本の起動を重くしないため、
// Service Worker の事前キャッシュには入れていない。
//
// タグは布地で歪み、印字も小さいので、読み取りは万能ではない。結果はそのまま
// 使わせず、編集できるテキスト欄に入れて人が直せるようにしてある。

const VENDOR = new URL("../vendor/tesseract/", import.meta.url).href;

// 日本語として扱う文字（かな・漢字・長音・々）
const JP_CHAR = "぀-ヿ㐀-鿿ー々";
const JP_GAP = new RegExp(`([${JP_CHAR}])[ \t]+(?=[${JP_CHAR}])`, "g");
const MEANINGFUL = /[0-9A-Za-z぀-ヿ一-鿿]/g;

// 実測: きちんと写ったタグは 90 前後、文字の無い布や模様だけの写真は 0〜50。
// 布のしわを字と見なした「HI」のような幻を入れないよう、境目は高めに取る。
/** 信頼度がこれ未満なら読み取り失敗とみなす */
export const MIN_CONFIDENCE = 60;
/** これ未満なら「不確か」として人に確認を促す */
export const SHAKY_CONFIDENCE = 80;

let workerPromise = null;
let workerLangs = "";

/** OCR の下準備。拡大してグレースケール化し、コントラストを伸ばす。 */
async function preprocess(blob, maxEdge = 1800) {
  const bitmap = await createImageBitmap(blob);
  // 小さい写真は拡大したほうが読める。ただし 2 倍まで
  const scale = Math.min(2, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const image = ctx.getImageData(0, 0, width, height);
  const px = image.data;
  const histogram = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) {
    const gray = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
    px[i] = px[i + 1] = px[i + 2] = gray;
    histogram[gray] += 1;
  }

  // 上下 2% を切り捨ててから 0-255 に伸ばす。布の影で全体が灰色になるのを戻す
  const cut = width * height * 0.02;
  let low = 0;
  let high = 255;
  for (let value = 0, acc = 0; value < 256; value += 1) {
    acc += histogram[value];
    if (acc > cut) { low = value; break; }
  }
  for (let value = 255, acc = 0; value >= 0; value -= 1) {
    acc += histogram[value];
    if (acc > cut) { high = value; break; }
  }
  const range = Math.max(1, high - low);
  for (let i = 0; i < px.length; i += 4) {
    const value = Math.max(0, Math.min(255, ((px[i] - low) * 255) / range));
    px[i] = px[i + 1] = px[i + 2] = value;
  }
  ctx.putImageData(image, 0, 0);

  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

async function getWorker(langs, onProgress) {
  if (workerPromise && workerLangs === langs) return workerPromise;
  if (workerPromise) {
    const previous = await workerPromise.catch(() => null);
    await previous?.terminate();
  }
  workerLangs = langs;
  workerPromise = (async () => {
    const { default: Tesseract } = await import(`${VENDOR}tesseract.esm.min.js`);
    return Tesseract.createWorker(langs, 1, {
      workerPath: `${VENDOR}worker.min.js`,
      corePath: VENDOR,
      langPath: `${VENDOR}lang`,
      // 同梱の traineddata は非圧縮で置いてある。.gz にすると配信側が
      // Content-Encoding を付けるかどうかで二重展開の事故が起きうるため
      gzip: false,
      logger: (message) => onProgress?.(message),
    });
  })();
  return workerPromise;
}

/**
 * 日本語の文字の間に入った空白を詰める。
 * OCR は「サイ ズ M」「日 本 製」のように切ってくることがあり、そのままでは
 * サイズの照合にもブランド名の照合にも引っかからない。
 * 日本語は元々語の間に空白を入れないので、かな・漢字どうしの間だけ詰めてよい。
 */
function joinJapaneseGaps(line) {
  let joined = line;
  let previous;
  do {
    previous = joined;
    joined = joined.replace(JP_GAP, "$1");
  } while (joined !== previous);
  return joined;
}

/**
 * 読み取り結果から、明らかな読み取り失敗の行を落とす。
 * 記号だらけの行や 1 文字だけの行は、布のしわや縫い目を字と見なした残骸。
 */
export function cleanOcrText(raw) {
  const lines = (raw || "")
    .normalize("NFKC")
    .split(/\r?\n/)
    .map((line) => joinJapaneseGaps(line.replace(/[ \t]+/g, " ").trim()))
    .filter((line) => line.length >= 2)
    .filter((line) => {
      const good = (line.match(MEANINGFUL) || []).length;
      return good >= 2 && good / line.length >= 0.5;
    });
  // 同じ行が続いたら 1 つにまとめる
  return lines.filter((line, index) => line !== lines[index - 1]).join("\n");
}

/**
 * 写真から文字を読む。japanese を立てると日本語も対象にする（その分遅い）。
 * 戻り値の confidence は 0-100。模様だけの写真は 0 近くになるので、
 * 「HI」のような幻の文字を拾わずに済む。
 */
export async function readTextFromImage(blob, { japanese = false, onProgress } = {}) {
  const langs = japanese ? "jpn+eng" : "eng";
  const worker = await getWorker(langs, onProgress);
  const prepared = await preprocess(blob);
  const { data } = await worker.recognize(prepared);
  const confidence = Math.round(data.confidence ?? 0);
  return {
    confidence,
    text: confidence >= MIN_CONFIDENCE ? cleanOcrText(data.text) : "",
  };
}

/** 使い終わったら開放する。 */
export async function releaseOcr() {
  const worker = await workerPromise?.catch(() => null);
  await worker?.terminate();
  workerPromise = null;
  workerLangs = "";
}
