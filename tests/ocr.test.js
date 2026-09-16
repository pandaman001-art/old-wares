import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cleanOcrText } from "../js/ocr.js";

describe("cleanOcrText", () => {
  it("読めた行はそのまま残す", () => {
    assert.equal(cleanOcrText("THE NORTH FACE\nND91841"), "THE NORTH FACE\nND91841");
  });

  it("記号だらけの行を落とす", () => {
    // 布のしわや縫い目を字と見なした残骸
    assert.equal(cleanOcrText("THE NORTH FACE\n~|_.-\nND91841"), "THE NORTH FACE\nND91841");
  });

  it("1 文字だけの行を落とす", () => {
    assert.equal(cleanOcrText("A\nND91841"), "ND91841");
  });

  it("余分な空白を詰める", () => {
    assert.equal(cleanOcrText("  THE   NORTH  FACE  "), "THE NORTH FACE");
  });

  it("全角を正規化する", () => {
    assert.equal(cleanOcrText("ＮＤ９１８４１"), "ND91841");
  });

  it("同じ行が続いたらまとめる", () => {
    assert.equal(cleanOcrText("SIZE L\nSIZE L\nND91841"), "SIZE L\nND91841");
  });

  it("日本語の行は残す", () => {
    assert.equal(cleanOcrText("ナイロン100%\n日本製"), "ナイロン100%\n日本製");
  });

  it("空の入力", () => {
    assert.equal(cleanOcrText(""), "");
    assert.equal(cleanOcrText(null), "");
  });

  it("読み取れなかった場合は空になる", () => {
    assert.equal(cleanOcrText("|\n~\n--\n. ."), "");
  });
});

describe("cleanOcrText（日本語の空白詰め）", () => {
  it("かな同士の間の空白を詰める", () => {
    // OCR は「サイ ズ M」のように切ってくる。詰めないとサイズとして拾えない
    assert.equal(cleanOcrText("サイ ズ M"), "サイズ M");
  });

  it("漢字同士の間も詰める", () => {
    assert.equal(cleanOcrText("日 本 製"), "日本製");
  });

  it("カタカナの長音も日本語として扱う", () => {
    assert.equal(cleanOcrText("ウル トラ ライ ト ダ ウン"), "ウルトラライトダウン");
  });

  it("日本語と数字の間の空白は残す", () => {
    assert.equal(cleanOcrText("ナイ ロン 100%"), "ナイロン 100%");
  });

  it("英字の間の空白は詰めない", () => {
    assert.equal(cleanOcrText("THE NORTH FACE"), "THE NORTH FACE");
  });

  it("日本語と英字の間も詰めない", () => {
    assert.equal(cleanOcrText("サイズ M"), "サイズ M");
  });
});
