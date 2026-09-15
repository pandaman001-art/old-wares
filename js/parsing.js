// 検索結果ページから貼り付けたテキストを、商品名と価格の組に変換する。
//
// ヤフオクの落札相場ページやメルカリの検索結果をブラウザで開き、一覧をドラッグして
// コピーしたものをそのまま受け取る前提。レイアウトはサイトごとに違うので、
// 行の並びではなく「金額らしい行」と「商品名らしい行」の距離で対応づける。
// CSV / TSV を貼った場合はそちらのモードで読む。

// 金額の書き方。通貨記号か「円」が付いているものだけを金額として扱う
const CURRENCY_AMOUNT = /¥\s*([0-9][0-9,]*)|([0-9][0-9,]*)\s*円/g;
// 行まるごとが金額（「¥12,800」「12,800円」「12800」）
const PRICE_ONLY = /^¥?\s*([0-9][0-9,]*)\s*円?$/;
// 「落札 18,500円」のようにラベルが直前に付く形
const WINNING_BID = /落札[^0-9¥]{0,6}(?:¥\s*([0-9][0-9,]*)|([0-9][0-9,]*)\s*円)/;
// 落札価格ではない金額の行（これらは統計に入れない）
const NON_FINAL_PRICE = /^(?:即決|開始価格|開始|現在の?価格|現在|最低落札|希望価格)/;
// 商品名の末尾に残る終了日・売却日
const TRAILING_DATE = /\s*(?:\d{4}[./年-]\d{1,2}[./月-]\d{1,2}日?|\d{1,2}[./月]\d{1,2}日?)\s*$/;
// 「1,234」のような桁区切りのカンマ（表の区切りと区別するために取り除く）
const THOUSANDS_COMMA = /(\d),(?=\d{3}(?!\d))/g;

// 商品名として採用しない、一覧ページの飾り
const NOISE = new RegExp(
  "^(?:送料|着払|いいね|ウォッチ|入札|残り|出品者?|並び替え|絞り込み|検索結果|該当|" +
  "前へ|次へ|ページ|すべて|カテゴリ|新着|おすすめ|広告|PR|SOLD|売り切れ|" +
  "即決|落札|開始価格|現在|税込|税抜|中古|新品|未使用|フォロー|もっと見る)" +
  "|^\\d+\\s*(?:日|時間|分)前" +
  "|^\\d{4}[./年-]\\d{1,2}" +
  "|^\\d{1,2}[./月]\\d{1,2}日?$" +
  "|^[\\d,.\\s%¥円件点個]+$"
);

// 明細としてありえない金額（1 円スタートの表示などを拾わないための下限）
export const MIN_PLAUSIBLE_PRICE = 300;

const clean = (text) => (text || "").normalize("NFKC").replace(/￥/g, "¥");
const toInt = (raw) => {
  const value = Number.parseInt(String(raw).replace(/,/g, ""), 10);
  return Number.isNaN(value) ? null : value;
};

/**
 * 1 行から代表となる金額を 1 つ選ぶ。
 * 「落札」ラベル付きの金額を最優先し、次いで下限以上で最初に出てくる金額を採る。
 * 「即決 32,000円 落札 18,500円」で即決を拾わないための順序。
 */
export function extractPrice(line) {
  const winning = WINNING_BID.exec(line);
  if (winning) {
    const value = toInt(winning[1] ?? winning[2]);
    if (value !== null) return value;
  }
  let fallback = null;
  for (const match of line.matchAll(CURRENCY_AMOUNT)) {
    const value = toInt(match[1] ?? match[2]);
    if (value === null) continue;
    if (value >= MIN_PLAUSIBLE_PRICE) return value;
    if (fallback === null) fallback = value;
  }
  return fallback;
}

function looksLikeTitle(line) {
  if (line.length < 2 || NOISE.test(line)) return false;
  // 数字と記号だけの行は商品名ではない
  return /[^\d\s,.\-¥円()（）]/.test(line);
}

/** 商品名と同じ行にある金額と日付を取り除く。 */
function stripPrices(line) {
  const withoutPrices = line.replace(CURRENCY_AMOUNT, " ").replace(/\s{2,}/g, " ").trim();
  return withoutPrices.replace(TRAILING_DATE, "").replace(/^[\s　\-–—:：|/]+|[\s　\-–—:：|/]+$/g, "");
}

/** タブ区切り、または桁区切り以外のカンマを含む行が過半なら表とみなす。 */
function looksLikeTable(lines) {
  if (!lines.length) return false;
  const delimited = lines.filter(
    (line) => line.includes("\t") || line.replace(THOUSANDS_COMMA, "$1").includes(",")
  ).length;
  return delimited >= Math.max(2, Math.ceil(lines.length / 2));
}

/** タブ / カンマ区切りの表として読む。価格は右端の数値列。 */
function parseTable(lines) {
  const entries = [];
  for (const line of lines) {
    const fields = (line.includes("\t") ? line.split("\t") : line.split(","))
      .map((f) => f.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    if (fields.length < 2) continue;
    let price = null;
    for (const field of [...fields].reverse()) {
      price = extractPrice(field) ?? toInt(field);
      if (price) break;
    }
    if (!price) continue;
    entries.push({ title: fields.find(looksLikeTitle) || "", price });
  }
  return entries;
}

/** 貼り付けたテキストを明細に変換する。 */
export function parsePastedText(text) {
  const cleaned = clean(text);
  const lines = cleaned.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const report = { entries: [], mode: "flow", lines: lines.length, pricesFound: 0, untitled: 0, ignoredSamples: [] };
  if (!lines.length) return report;

  if (looksLikeTable(lines)) {
    report.mode = "table";
    report.entries = parseTable(lines);
    report.pricesFound = report.entries.length;
    report.untitled = report.entries.filter((e) => !e.title).length;
    return report;
  }

  // --- 行の分類 ---
  const hasCurrency = cleaned.includes("¥") || cleaned.includes("円");
  const prices = [];   // { index, price }
  const titles = [];   // { index, title }
  for (const [index, line] of lines.entries()) {
    // 即決・開始価格などは実際に売れた金額ではないので捨てる
    if (NON_FINAL_PRICE.test(line)) continue;

    const only = PRICE_ONLY.exec(line);
    if (only) {
      const value = toInt(only[1]);
      // 通貨記号なしの裸の数字は、同じ貼り付けに通貨表記が無いときだけ金額扱い
      const marked = line.includes("¥") || line.includes("円");
      if (value !== null && (marked || !hasCurrency)) {
        prices.push({ index, price: value });
        continue;
      }
    }

    const inline = extractPrice(line);
    // 「1円スタート」のような小さすぎる数字は金額ではなく商品名の一部として扱う
    if (inline !== null && inline >= MIN_PLAUSIBLE_PRICE && (line.includes("¥") || line.includes("円"))) {
      prices.push({ index, price: inline });
      const rest = stripPrices(line);
      if (looksLikeTitle(rest)) titles.push({ index, title: rest });
      continue;
    }

    if (looksLikeTitle(line)) titles.push({ index, title: line });
    else if (report.ignoredSamples.length < 5) report.ignoredSamples.push(line);
  }

  report.pricesFound = prices.length;

  // --- 金額と商品名の対応づけ ---
  const used = new Set();
  for (const { index, price } of prices) {
    const candidates = [...titles].sort((a, b) => {
      // 未使用の商品名を優先し、次に距離、同距離なら金額より前にある行を優先
      const usedDiff = Number(used.has(a.index)) - Number(used.has(b.index));
      if (usedDiff) return usedDiff;
      const distDiff = Math.abs(a.index - index) - Math.abs(b.index - index);
      if (distDiff) return distDiff;
      return Number(a.index > index) - Number(b.index > index);
    });
    const chosen = candidates[0];
    if (chosen) used.add(chosen.index);
    else report.untitled += 1;
    report.entries.push({ title: chosen ? chosen.title : "", price });
  }
  return report;
}
