// 写真からタグの文字を読む（OCR）。
//
// 写真は端末の外に出さない。OCR エンジン（Tesseract）は vendor/ に同梱してあり、
// 「写真から文字を読む」を最初に押したときだけ読み込む。
//
// 実写のタグは合成画像と違い、
//   ・上下逆さまや横向きに写っている（Tesseract は向きを自動では直さない）
//   ・織りネームは地が濃く文字が白い（Tesseract は黒文字・白地を前提にする）
//   ・手の影や照明の反射で場所ごとに明るさが違う
// という三つで簡単に全滅する。下処理と向きの総当たりでそこを潰す。

const VENDOR = new URL("../vendor/tesseract/", import.meta.url).href;

// 日本語として扱う文字（かな・漢字・長音・々）
const JP_CHAR = "぀-ヿ㐀-鿿ー々";
const JP_GAP = new RegExp(`([${JP_CHAR}])[ \t]+(?=[${JP_CHAR}])`, "g");
const MEANINGFUL = /[0-9A-Za-z぀-ヿ一-鿿]/g;

// しきい値は実写で調整すること。きれいな合成画像は 90 を超えるが、
// 手持ちで撮ったタグは中身が正しく読めていても 40-55 にしかならない。
// 高くすると、正しく読めた品番ごと捨ててしまう。
/** 行ごとの信頼度がこれ未満なら捨てる */
export const MIN_LINE_CONFIDENCE = 30;
/** 全体がこれ未満なら「不確か」として人に確認を促す */
export const SHAKY_CONFIDENCE = 70;
/** 文字らしい字がこれだけ取れなければ、読み取り失敗とみなす */
const MIN_MEANINGFUL_CHARS = 6;

// 向きを決めるための下見はこの大きさで行う（小さいほど速い）
const PROBE_EDGE = 640;
// 本番の読み取りはこの大きさまで拡大する
const MAX_EDGE = 2200;
const ROTATIONS = [0, 90, 180, 270];

let workerPromise = null;
let workerLangs = "";

/* ---------- 画像の下処理 ---------- */

function makeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** 長辺を maxEdge に合わせて拡大・縮小した canvas を返す。 */
function toScaled(bitmap, maxEdge) {
  // 小さい写真は拡大したほうが読める。ただし 3 倍まで
  const scale = Math.min(3, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = makeCanvas(
    Math.max(1, Math.round(bitmap.width * scale)),
    Math.max(1, Math.round(bitmap.height * scale))
  );
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** 拡大したうえでグレースケール化した canvas を返す。 */
function toGray(bitmap, maxEdge) {
  const canvas = toScaled(bitmap, maxEdge);
  const { width, height } = canvas;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, width, height);
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    px[i] = px[i + 1] = px[i + 2] = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * 局所的なしきい値で白黒にする（積分画像を使った適応二値化）。
 * 写真全体で 1 つのしきい値を使うと、手の影がかかった側が丸ごと潰れる。
 * 文字が白い織りネームだったときは、黒画素が多数派になるので反転させる。
 */
function binarize(canvas) {
  const { width, height } = canvas;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, width, height);
  const px = image.data;

  // 積分画像（各画素までの輝度の総和）
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      rowSum += px[(y * width + x) * 4];
      integral[(y + 1) * (width + 1) + (x + 1)] = integral[y * (width + 1) + (x + 1)] + rowSum;
    }
  }

  // 窓は文字の高さより少し大きいくらいが効く
  const radius = Math.max(8, Math.round(Math.max(width, height) / 45));
  let ink = 0;
  const out = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const count = (y1 - y0 + 1) * (x1 - x0 + 1);
      const sum =
        integral[(y1 + 1) * (width + 1) + (x1 + 1)] -
        integral[y0 * (width + 1) + (x1 + 1)] -
        integral[(y1 + 1) * (width + 1) + x0] +
        integral[y0 * (width + 1) + x0];
      // 平均より少し暗ければインクとみなす
      const dark = px[(y * width + x) * 4] < (sum / count) * 0.88;
      out[y * width + x] = dark ? 0 : 255;
      if (dark) ink += 1;
    }
  }

  // 黒が多数派なら文字が白い（織りネーム）。白黒を入れ替える
  const invert = ink > width * height * 0.5;
  for (let i = 0; i < out.length; i += 1) {
    const value = invert ? 255 - out[i] : out[i];
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = value;
    px[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** canvas を 90 度単位で回した新しい canvas を返す。 */
function rotate(source, degrees) {
  if (degrees === 0) return source;
  const swap = degrees === 90 || degrees === 270;
  const canvas = makeCanvas(swap ? source.height : source.width, swap ? source.width : source.height);
  const ctx = canvas.getContext("2d");
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

function resize(source, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
  if (scale === 1) return source;
  const canvas = makeCanvas(Math.round(source.width * scale), Math.round(source.height * scale));
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const toBlob = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, "image/png"));

/* ---------- エンジン ---------- */

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

/* ---------- 文字列の整形 ---------- */

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

/** 1 行が中身のある文字列か。記号だらけの行は布のしわを字と見なした残骸。 */
export function isUsefulLine(line) {
  if (!line || line.length < 3) return false;
  const good = (line.match(MEANINGFUL) || []).length;
  return good >= 3 && good / line.length >= 0.5;
}

/** 読み取れた「文字らしい字」の数。少なすぎるものは幻とみなす。 */
export function meaningfulCount(text) {
  return ((text || "").match(MEANINGFUL) || []).length;
}

/**
 * 品番の途中に入った空白を詰める。
 * 「331 -359039」「ND 91841」のように切られると品番として拾えない。
 * ハイフンの前後と、英字 1-4 文字＋数字の並びだけを対象にする。
 */
function joinCodeGaps(line) {
  return line
    .replace(/(\w)\s+-\s*(\d)/g, "$1-$2")
    .replace(/(\d)\s*-\s+(\d)/g, "$1-$2")
    .replace(/\b([A-Z]{1,4})\s+(\d{3,7})\b/g, "$1$2");
}

/** 読み取り結果から、明らかな読み取り失敗の行を落とす。 */
export function cleanOcrText(raw) {
  const lines = (raw || "")
    .normalize("NFKC")
    .split(/\r?\n/)
    .map((line) => joinCodeGaps(joinJapaneseGaps(line.replace(/[ \t]+/g, " ").trim())))
    .filter(isUsefulLine);
  // 同じ行が続いたら 1 つにまとめる
  return lines.filter((line, index) => line !== lines[index - 1]).join("\n");
}

/**
 * 行ごとの信頼度で選り分ける。全体が低くても、はっきり読めた行は使いたい。
 * 品番だけ読めれば検索には充分なので、全か無かにはしない。
 */
export function pickConfidentLines(lines, minConfidence = MIN_LINE_CONFIDENCE) {
  return cleanOcrText(
    (lines || [])
      .filter((line) => (line.confidence ?? 0) >= minConfidence)
      .map((line) => line.text)
      .join("\n")
  );
}

function linesOf(data) {
  if (Array.isArray(data.lines) && data.lines.length) return data.lines;
  return (data.blocks || []).flatMap((block) =>
    (block.paragraphs || []).flatMap((paragraph) => paragraph.lines || [])
  );
}

/* ---------- 本体 ---------- */

/**
 * 写真から文字を読む。
 * 向きが分からないので 0/90/180/270 を小さい画像で下見し、いちばん確からしい
 * 向きだけを本番の大きさで読み直す。実写のタグは上下逆に写っていることが多い。
 */
export async function readTextFromImage(blob, { japanese = true, onProgress } = {}) {
  const langs = japanese ? "jpn+eng" : "eng";
  const worker = await getWorker(langs, onProgress);

  const bitmap = await createImageBitmap(blob);
  // 拡大だけしたものと、二値化したもの。二値化は地が濃い織りネームには効くが
  // 小さい文字は潰してしまうので、どちらが良いかは写真による。両方試して良いほうを採る
  const scaled = toScaled(bitmap, MAX_EDGE);
  const gray = toGray(bitmap, MAX_EDGE);
  const binary = binarize(toGray(bitmap, MAX_EDGE));
  bitmap.close?.();

  // 向きの下見。小さい画像で 4 方向を試す。
  // 二値化だけで判定すると、小さい文字が潰れた写真で当てずっぽうになるので、
  // グレースケール版でも見て確からしいほうを採る
  const probes = [resize(gray, PROBE_EDGE), resize(binary, PROBE_EDGE)];
  let best = { degrees: 0, confidence: -1 };
  let step = 0;
  for (const probe of probes) {
    for (const degrees of ROTATIONS) {
      step += 1;
      onProgress?.({ status: "checking orientation", progress: step / (probes.length * ROTATIONS.length) });
      const { data } = await worker.recognize(await toBlob(rotate(probe, degrees)));
      const confidence = data.confidence ?? 0;
      if (confidence > best.confidence) best = { degrees, confidence };
    }
  }

  // はっきり読めた時点で打ち切る。全部試すと待ち時間が伸びるだけ
  const GOOD_ENOUGH = 85;
  let result = { text: "", confidence: -1, degrees: best.degrees };
  const variants = [scaled, gray, binary];
  for (const [index, variant] of variants.entries()) {
    if (result.confidence >= GOOD_ENOUGH) break;
    onProgress?.({ status: "recognizing text", progress: index / variants.length });
    const { data } = await worker.recognize(
      await toBlob(rotate(variant, best.degrees)), {}, { blocks: true, text: true }
    );
    const confidence = Math.round(data.confidence ?? 0);
    if (confidence <= result.confidence) continue;
    const lines = linesOf(data);
    result = {
      text: lines.length ? pickConfidentLines(lines) : cleanOcrText(data.text),
      confidence,
      degrees: best.degrees,
    };
  }
  // 文字がほとんど取れていないなら、布のしわを字と見なしただけ
  if (meaningfulCount(result.text) < MIN_MEANINGFUL_CHARS) result.text = "";
  return result;
}

/** 使い終わったら開放する。 */
export async function releaseOcr() {
  const worker = await workerPromise?.catch(() => null);
  await worker?.terminate();
  workerPromise = null;
  workerLangs = "";
}
