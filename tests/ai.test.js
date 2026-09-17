import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildRequest, FALLBACK_MODEL, parseResponse, pickBestModel } from "../js/ai.js";

describe("buildRequest", () => {
  const request = buildRequest("QkFTRTY0");

  it("画像とプロンプトを 1 つの内容として送る", () => {
    assert.equal(request.contents.length, 1);
    const [image, prompt] = request.contents[0].parts;
    assert.deepEqual(image.inlineData, { mimeType: "image/jpeg", data: "QkFTRTY0" });
    assert.ok(prompt.text.includes("タグ"));
  });

  it("上下逆さまでも読むよう指示している", () => {
    assert.match(request.contents[0].parts[1].text, /逆さま/);
  });

  it("推測で埋めないよう指示している", () => {
    assert.match(request.contents[0].parts[1].text, /推測/);
  });

  it("ぶれないよう temperature 0 で JSON を要求する", () => {
    assert.equal(request.generationConfig.temperature, 0);
    assert.equal(request.generationConfig.responseMimeType, "application/json");
    assert.equal(request.generationConfig.responseSchema.required[0], "text");
  });

  it("返してほしい項目を schema で指定している", () => {
    const keys = Object.keys(request.generationConfig.responseSchema.properties);
    assert.deepEqual(keys.sort(), ["brand", "made_in", "materials", "model_numbers", "sizes", "text"]);
  });
});

describe("parseResponse", () => {
  const wrap = (obj) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });

  it("構造化された結果を取り出す", () => {
    const { text, hint } = parseResponse(wrap({
      text: "GU\n336N004N",
      brand: "GU",
      model_numbers: ["336N004N", "331-359039"],
      sizes: ["M"],
      materials: ["ポリエステル"],
      made_in: "中国",
    }));
    assert.equal(text, "GU\n336N004N");
    assert.equal(hint.brand, "GU");
    assert.deepEqual(hint.modelNumbers, ["336N004N", "331-359039"]);
    assert.deepEqual(hint.sizes, ["M"]);
    assert.equal(hint.madeIn, "中国");
  });

  it("空の項目は null や空配列にそろえる", () => {
    const { hint } = parseResponse(wrap({ text: "よくわからない", brand: "", model_numbers: [] }));
    assert.equal(hint.brand, null);
    assert.deepEqual(hint.modelNumbers, []);
  });

  it("前後の空白を落とす", () => {
    const { text, hint } = parseResponse(wrap({ text: " GU ", brand: " GU ", model_numbers: [" 336N "] }));
    assert.equal(text, "GU");
    assert.equal(hint.brand, "GU");
    assert.deepEqual(hint.modelNumbers, ["336N"]);
  });

  it("JSON になっていなくても本文が読めれば使う", () => {
    const { text, hint } = parseResponse({ candidates: [{ content: { parts: [{ text: "GU 336N004N" }] } }] });
    assert.equal(text, "GU 336N004N");
    assert.deepEqual(hint, {});
  });

  it("写真が拒否されたら理由を伝える", () => {
    assert.throws(
      () => parseResponse({ promptFeedback: { blockReason: "SAFETY" } }),
      /受け付けられませんでした（SAFETY）/
    );
  });

  it("空の返事はエラーにする", () => {
    assert.throws(() => parseResponse({ candidates: [{ content: { parts: [] } }] }), /空でした/);
  });

  it("返事が無い場合もエラーにする", () => {
    assert.throws(() => parseResponse({}), /空でした/);
  });
});

describe("pickBestModel", () => {
  it("使えるモデルの中から新しい flash 系を選ぶ", () => {
    assert.equal(pickBestModel(["gemini-3.6-flash", "gemini-3.6-pro", "gemini-3.1-flash-lite"]), "gemini-3.6-flash");
  });

  it("版が新しいものを選ぶ", () => {
    assert.equal(pickBestModel(["gemini-2.5-flash", "gemini-3.6-flash"]), "gemini-3.6-flash");
  });

  it("preview は避ける（予告なく消えるため）", () => {
    assert.equal(pickBestModel(["gemini-4.0-flash-preview", "gemini-3.6-pro"]), "gemini-3.6-pro");
  });

  it("flash が無ければ pro を使う", () => {
    assert.equal(pickBestModel(["gemini-3.6-pro"]), "gemini-3.6-pro");
  });

  it("flash-lite より flash を優先する", () => {
    assert.equal(pickBestModel(["gemini-3.6-flash-lite", "gemini-3.6-flash"]), "gemini-3.6-flash");
  });

  it("候補が無ければ null", () => {
    assert.equal(pickBestModel([]), null);
    assert.equal(pickBestModel(undefined), null);
  });
});

describe("最後の手段のモデル名", () => {
  it("一覧が取れなかったときのために flash 系を持っておく", () => {
    assert.match(FALLBACK_MODEL, /^gemini-.*flash/);
  });
});
