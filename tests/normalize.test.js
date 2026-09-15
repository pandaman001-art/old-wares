import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyFilters, compileExtraExcludes, defaultRulesForQuery, exclusionReason, normalizeText,
} from "../js/normalize.js";

const listing = (title, price = 5000) => ({ title, price });

describe("normalizeText", () => {
  it("全角と連続空白を畳む", () => {
    assert.equal(normalizeText("Ｌサイズ　　ダウン"), "Lサイズ ダウン");
  });
});

describe("exclusionReason", () => {
  it("まとめ売りとジャンクを外す", () => {
    assert.equal(exclusionReason(listing("古着 まとめ売り 10点")), "まとめ売り");
    assert.equal(exclusionReason(listing("ジャンク品 ダウン")), "難あり");
  });

  it("セットアップはセット売りと誤判定しない", () => {
    assert.equal(exclusionReason(listing("スーツ セットアップ 美品")), null);
    assert.equal(exclusionReason(listing("Tシャツ 3枚セット")), "セット売り");
  });

  it("出品状態の記載は外さない", () => {
    // 「傷や汚れあり」はメルカリの正規の状態表記
    assert.equal(exclusionReason(listing("ダウン やや傷や汚れあり L")), null);
  });

  it("価格ガード", () => {
    assert.match(exclusionReason(listing("ダウン", 100)), /未満/);
    assert.match(exclusionReason(listing("ダウン", 9_000_000)), /超/);
  });
});

describe("defaultRulesForQuery", () => {
  it("検索語に含まれる語のルールは無効化する", () => {
    const defaultRules = defaultRulesForQuery("キッズ ダウン");
    assert.equal(exclusionReason(listing("キッズ ダウン 120"), { defaultRules }), null);
    // 検索語に含まれない他のルールは生きている
    assert.equal(exclusionReason(listing("まとめ売り"), { defaultRules }), "まとめ売り");
  });
});

describe("compileExtraExcludes", () => {
  it("ユーザー指定の語で外せる", () => {
    const extraRules = compileExtraExcludes(["ジュニア"]);
    assert.match(exclusionReason(listing("ジュニア ダウン"), { extraRules }), /^除外語/);
  });

  it("正規表現ではなく素の文字列として扱う", () => {
    const extraRules = compileExtraExcludes(["a.c"]);
    assert.equal(exclusionReason(listing("abc ダウン"), { extraRules }), null);
    assert.match(exclusionReason(listing("a.c ダウン"), { extraRules }), /^除外語/);
  });
});

describe("applyFilters", () => {
  it("listing に印をつける", () => {
    const rows = [listing("ダウン L"), listing("まとめ売り")];
    applyFilters(rows, { query: "ダウン" });
    assert.equal(rows[0].excluded, false);
    assert.equal(rows[1].excluded, true);
    assert.equal(rows[1].excludeReason, "まとめ売り");
  });

  it("既定の除外を切れる", () => {
    const rows = [listing("まとめ売り")];
    applyFilters(rows, { useDefaults: false });
    assert.equal(rows[0].excluded, false);
  });
});
