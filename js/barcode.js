// バーコード読み取り。
//
// ブラウザ標準の BarcodeDetector だけを使う（Android の Chrome などで動く）。
// 読み取りライブラリは同梱しないので、対応していない端末ではボタンを出さない。
// 読み取った番号はそのまま検索語として使う。外部への問い合わせは一切しない。
//
// カメラの開け閉めは camera.js と共通。写真撮影と同じ映像を使う。

import { startCamera } from "./camera.js";

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf"];

// JAN / EAN の先頭 2-3 桁が示す国（主なものだけ）
const COUNTRY_PREFIXES = [
  [/^4[59]/, "日本"],
  [/^0[0-9]|^1[0-3]/, "アメリカ・カナダ"],
  [/^3[0-7]/, "フランス"],
  [/^4[0-4]/, "ドイツ"],
  [/^471/, "台湾"],
  [/^489/, "香港"],
  [/^50/, "イギリス"],
  [/^6[89][0-9]/, "中国"],
  [/^8[0-3]/, "イタリア"],
  [/^84/, "スペイン"],
  [/^880/, "韓国"],
  [/^885/, "タイ"],
  [/^893/, "ベトナム"],
];

/** この端末でバーコード読み取りが使えるか。 */
export function barcodeSupported() {
  return typeof window !== "undefined" && "BarcodeDetector" in window;
}

/** EAN-13 / EAN-8 / UPC-A のチェックディジットを計算する。 */
export function checkDigit(digitsWithoutCheck) {
  const digits = [...digitsWithoutCheck].map(Number);
  // 右端から数えて奇数番目に 3 を掛ける
  const sum = digits
    .reverse()
    .reduce((acc, digit, index) => acc + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10;
}

/**
 * 読み取った番号を説明する。
 * 商品名までは分からない（そのためのデータベースを持たない）ので、
 * 分かるのは「正しい JAN か」「どこの国のコードか」までだと明示する。
 */
export function describeBarcode(rawValue) {
  const code = String(rawValue || "").replace(/\D/g, "");
  const result = { code, valid: false, kind: null, country: null, makerCode: null };
  if (!code) return result;

  if (code.length === 13) result.kind = "JAN/EAN-13";
  else if (code.length === 8) result.kind = "EAN-8";
  else if (code.length === 12) result.kind = "UPC-A";
  else {
    result.kind = `${code.length}桁のコード`;
    return result;
  }

  result.valid = checkDigit(code.slice(0, -1)) === Number(code.at(-1));
  if (code.length === 13) {
    const prefix = COUNTRY_PREFIXES.find(([pattern]) => pattern.test(code));
    result.country = prefix ? prefix[1] : null;
    // 日本の JAN はメーカーコードが 7 桁または 9 桁。ここでは 7 桁として切り出す
    result.makerCode = /^4[59]/.test(code) ? code.slice(0, 7) : null;
  }
  return result;
}

/**
 * すでに開いているカメラ映像からバーコードを 1 つ読む。
 * 映像の開け閉めは呼び出し側（camera.js の startCamera）が持つ。
 */
export async function detectFromVideo(video, signal) {
  if (!barcodeSupported()) throw new Error("この端末はバーコード読み取りに対応していません");
  const supported = await window.BarcodeDetector.getSupportedFormats();
  const formats = FORMATS.filter((format) => supported.includes(format));
  if (!formats.length) throw new Error("読み取れるバーコードの形式がありません");

  const detector = new window.BarcodeDetector({ formats });
  while (!signal?.aborted) {
    const codes = await detector.detect(video).catch(() => []);
    const hit = codes.find((code) => code.rawValue);
    if (hit) return hit.rawValue;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("読み取りを中止しました");
}

/** カメラを開いてバーコードを 1 つ読む。signal で中断できる。 */
export async function scanBarcode({ video, signal } = {}) {
  if (!barcodeSupported()) throw new Error("この端末はバーコード読み取りに対応していません");
  const camera = await startCamera(video);
  try {
    return await detectFromVideo(video, signal);
  } finally {
    camera.stop();
  }
}
