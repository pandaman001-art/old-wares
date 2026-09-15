import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractPrice, parsePastedText } from "../js/parsing.js";

const YAHOO_PASTE = `検索結果 1,234件
THE NORTH FACE ヌプシ 700 ダウンジャケット L ブラック
即決 32,000円
落札 18,500円
2026年9月1日
パタゴニア レトロX フリース M 2016
落札 24,800円
2026年8月30日`;

const MERCARI_PASTE = `¥12,800
ノースフェイス ヌプシ 700 Lサイズ
送料込み
SOLD
¥9,500
ノースフェイス ライトジャケット M
送料込み`;

const pairs = (text) => parsePastedText(text).entries.map((e) => [e.price, e.title]);

describe("extractPrice", () => {
  it("いろいろな書き方の金額を読む", () => {
    assert.equal(extractPrice("¥12,800"), 12800);
    assert.equal(extractPrice("12,800円"), 12800);
    assert.equal(extractPrice("12800円"), 12800);
    assert.equal(extractPrice("送料込み"), null);
  });

  it("即決ではなく落札価格を採る", () => {
    assert.equal(extractPrice("即決 32,000円 落札 18,500円"), 18500);
  });

  it("1 円スタートの表示を飛ばす", () => {
    assert.equal(extractPrice("1円スタート 現在 18,500円"), 18500);
  });
});

describe("ヤフオク形式", () => {
  it("落札価格だけを取り、即決は入れない", () => {
    const report = parsePastedText(YAHOO_PASTE);
    assert.equal(report.mode, "flow");
    assert.deepEqual(report.entries.map((e) => e.price), [18500, 24800]);
    assert.equal(report.entries[0].title, "THE NORTH FACE ヌプシ 700 ダウンジャケット L ブラック");
    assert.equal(report.untitled, 0);
  });

  it("1 行に混在していても商品名から金額と日付を落とす", () => {
    assert.deepEqual(
      pairs("THE NORTH FACE ヌプシ 700 L 18,500円 2026年9月1日\nパタゴニア レトロX M ¥24,800 2026/08/30"),
      [[18500, "THE NORTH FACE ヌプシ 700 L"], [24800, "パタゴニア レトロX M"]]
    );
  });

  it("商品名の中の数字を価格と取り違えない", () => {
    assert.deepEqual(pairs("ノースフェイス ヌプシ 700 1996年モデル\n落札 18,500円"), [
      [18500, "ノースフェイス ヌプシ 700 1996年モデル"],
    ]);
  });

  it("1円スタートは商品名の一部として扱う", () => {
    assert.deepEqual(pairs("ノースフェイス ヌプシ 1円スタート\n落札 18,500円"), [
      [18500, "ノースフェイス ヌプシ 1円スタート"],
    ]);
  });
});

describe("メルカリ形式（価格が商品名より前）", () => {
  it("後ろの商品名と対応づける", () => {
    assert.deepEqual(pairs(MERCARI_PASTE), [
      [12800, "ノースフェイス ヌプシ 700 Lサイズ"],
      [9500, "ノースフェイス ライトジャケット M"],
    ]);
  });

  it("一覧ページの飾りは商品名にしない", () => {
    assert.ok(parsePastedText(MERCARI_PASTE).ignoredSamples.includes("送料込み"));
  });

  it("商品名は 1 つの価格にだけ使う", () => {
    assert.deepEqual(pairs("¥1,000\nコートA\n¥2,000\nコートB\n¥3,000\nコートC"), [
      [1000, "コートA"], [2000, "コートB"], [3000, "コートC"],
    ]);
  });
});

describe("表形式", () => {
  it("CSV を読む", () => {
    const report = parsePastedText("タイトル,価格\nノースフェイス ヌプシ L,18500\nパタゴニア レトロX M,24800");
    assert.equal(report.mode, "table");
    assert.deepEqual(report.entries.map((e) => [e.title, e.price]), [
      ["ノースフェイス ヌプシ L", 18500], ["パタゴニア レトロX M", 24800],
    ]);
  });

  it("TSV を読む", () => {
    const report = parsePastedText("ノースフェイス ヌプシ L\t18,500円\nパタゴニア レトロX M\t24,800円");
    assert.equal(report.mode, "table");
    assert.deepEqual(report.entries.map((e) => e.price), [18500, 24800]);
  });

  it("桁区切りのカンマを表の区切りと誤認しない", () => {
    assert.equal(parsePastedText(YAHOO_PASTE).mode, "flow");
  });
});

describe("価格だけの貼り付け", () => {
  it("通貨記号が無ければ裸の数字を価格とみなす", () => {
    const report = parsePastedText("18500\n24800\n9800");
    assert.deepEqual(report.entries.map((e) => e.price), [18500, 24800, 9800]);
    assert.equal(report.untitled, 3);
  });

  it("通貨記号がある貼り付けでは裸の数字を価格としない", () => {
    // 「700」はサイズ表記であって価格ではない
    assert.deepEqual(parsePastedText("ノースフェイス ヌプシ\n700\n¥18,500").entries.map((e) => e.price), [18500]);
  });
});

describe("端のケース", () => {
  it("空のテキスト", () => {
    const report = parsePastedText("   \n\n");
    assert.deepEqual(report.entries, []);
    assert.equal(report.lines, 0);
  });

  it("価格が 1 つも無いテキスト", () => {
    const report = parsePastedText("ノースフェイス ヌプシ\nパタゴニア レトロX");
    assert.deepEqual(report.entries, []);
    assert.equal(report.pricesFound, 0);
  });

  it("全角文字を正規化する", () => {
    assert.deepEqual(parsePastedText("ノースフェイス Ｌサイズ\n￥１２，８００").entries.map((e) => e.price), [12800]);
  });

  it("同じ正規表現を続けて使っても結果が変わらない", () => {
    assert.deepEqual(pairs(MERCARI_PASTE), pairs(MERCARI_PASTE));
  });
});
