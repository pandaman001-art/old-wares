import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_GROUPS, quote, searchPageUrl } from "../js/quote.js";

const group = (key, label, prices, title = "ダウンジャケット L") => ({
  key, label, entries: prices.map((price) => ({ title, price })),
});

const twoGroups = (yahooPrices, mercariPrices) => [
  group("yahoo", "ヤフオク", yahooPrices),
  group("mercari", "メルカリ", mercariPrices),
];

describe("相場の出し方", () => {
  it("各サイトの中央値を等ウェイトで平均する", () => {
    const result = quote("ダウン", twoGroups([1000, 2000, 3000], [5000, 6000, 7000]));
    assert.equal(result.blend.equalWeightMedian, 4000); // (2000 + 6000) / 2
    assert.deepEqual(result.blend.sourcesUsed, ["yahoo", "mercari"]);
    assert.equal(result.combined.count, 6);
  });

  it("件数の多い側に引っ張られない", () => {
    const result = quote("ダウン", twoGroups(new Array(50).fill(2000), new Array(4).fill(6000)));
    assert.equal(result.blend.equalWeightMedian, 4000);
    // 件数で加重するとヤフオク寄りになる。等ウェイトはそれを避けるためにある
    assert.equal(result.blend.weightedMean, 2296);
  });

  it("片方だけでも成立し、その旨を警告する", () => {
    const result = quote("ダウン", [group("yahoo", "ヤフオク", [5000, 6000, 7000, 8000, 9000])]);
    assert.equal(result.blend.equalWeightMedian, 7000);
    assert.ok(result.warnings.some((w) => w.includes("片方のサイトだけ")));
  });

  it("空のグループが混ざっても他方は計算できる", () => {
    const result = quote("ダウン", [group("yahoo", "ヤフオク", []), group("mercari", "メルカリ", [5000, 6000, 7000])]);
    assert.equal(result.combined.count, 3);
    assert.deepEqual(result.blend.sourcesUsed, ["mercari"]);
  });
});

describe("ノイズ除去", () => {
  it("まとめ売りを統計から外す", () => {
    const entries = new Array(6).fill(0).map(() => ({ title: "ダウン L", price: 5000 }));
    entries.push({ title: "ノースフェイス まとめ売り 10点", price: 2000 });
    const result = quote("ダウン", [{ key: "yahoo", label: "ヤフオク", entries }]);
    const source = result.sources[0];
    assert.equal(source.stats.count, 6);
    assert.equal(source.excludedCount, 1);
    assert.equal(source.listings.at(-1).excludeReason, "まとめ売り");
  });

  it("外れ値を除いて件数を数える", () => {
    const prices = [5000, 5100, 5200, 5300, 5400, 5500, 5600, 5700, 900000];
    const result = quote("ダウン", [group("yahoo", "ヤフオク", prices)]);
    assert.equal(result.sources[0].outlierCount, 1);
    assert.equal(result.sources[0].stats.max, 5700);
  });

  it("外れ値除去を切れる", () => {
    const prices = [5000, 5100, 5200, 5300, 5400, 5500, 5600, 5700, 900000];
    const result = quote("ダウン", [group("yahoo", "ヤフオク", prices)], { removeOutliers: false });
    assert.equal(result.sources[0].outlierCount, 0);
    assert.equal(result.sources[0].stats.max, 900000);
  });

  it("除外語を適用する", () => {
    const entries = [{ title: "ダウン L", price: 5000 }, { title: "ジュニア ダウン", price: 3000 }];
    const result = quote("ダウン", [{ key: "yahoo", label: "ヤフオク", entries }], { excludeWords: ["ジュニア"] });
    assert.equal(result.sources[0].stats.count, 1);
  });

  it("価格の下限を適用する", () => {
    const result = quote("ダウン", [group("yahoo", "ヤフオク", [1000, 5000, 9000])], { priceMin: 4000 });
    assert.equal(result.sources[0].stats.count, 2);
  });
});

describe("貼り付けテキストからの経路", () => {
  it("両サイトの貼り付けを解析して相場を出す", () => {
    const result = quote("ヌプシ", [
      { key: "yahoo", label: "ヤフオク", text: "ヌプシ A\n落札 9,800円\nヌプシ B\n落札 11,200円\nヌプシ C\n落札 10,500円" },
      { key: "mercari", label: "メルカリ", text: "¥13,800\nヌプシ D\n¥12,400\nヌプシ E\n¥14,000\nヌプシ F" },
    ]);
    assert.deepEqual(result.sources.map((s) => s.parse.pricesFound), [3, 3]);
    assert.equal(result.blend.equalWeightMedian, 12150); // (10500 + 13800) / 2
    assert.deepEqual(result.histogram.series, ["ヤフオク", "メルカリ"]);
  });

  it("読み取れないテキストはそのグループだけエラーにする", () => {
    const result = quote("ヌプシ", [
      { key: "yahoo", label: "ヤフオク", text: "ノースフェイス ヌプシ\nパタゴニア レトロX" },
      { key: "mercari", label: "メルカリ", text: "¥13,800\nヌプシ C\n¥12,400\nヌプシ D" },
    ]);
    assert.match(result.sources[0].error, /読み取れませんでした/);
    assert.equal(result.sources[1].stats.count, 2);
    assert.equal(result.combined.count, 2);
    assert.ok(result.warnings.some((w) => w.includes("ヤフオク")));
  });

  it("入力が無ければ警告する", () => {
    const result = quote("ヌプシ", [{ key: "yahoo", label: "ヤフオク", text: "" }]);
    assert.equal(result.combined.count, 0);
    assert.ok(result.warnings.some((w) => w.includes("貼り付けて")));
  });

  it("件数が少なければ警告する", () => {
    const result = quote("ヌプシ", twoGroups([1000, 2000], [5000, 6000]));
    assert.ok(result.warnings.some((w) => w.includes("信頼度は低め")));
  });
});

describe("検索ページのリンク", () => {
  it("売れたものだけが出る URL を組み立てる", () => {
    assert.match(searchPageUrl("yahoo", "ヌプシ 700"), /closedsearch/);
    assert.match(searchPageUrl("mercari", "ヌプシ 700"), /status=sold_out/);
  });

  it("検索語を URL エンコードする", () => {
    assert.match(searchPageUrl("yahoo", "ヌプシ 700"), /%20700/);
  });

  it("知らないキーは空文字", () => {
    assert.equal(searchPageUrl("rakuma", "x"), "");
  });

  it("既定は 2 サイト", () => {
    assert.deepEqual(DEFAULT_GROUPS.map((g) => g.key), ["yahoo", "mercari"]);
  });
});
