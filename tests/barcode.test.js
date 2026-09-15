import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { barcodeSupported, checkDigit, describeBarcode } from "../js/barcode.js";

describe("checkDigit", () => {
  it("JAN のチェックディジットを計算する", () => {
    assert.equal(checkDigit("490123456789"), 4);
    assert.equal(checkDigit("456995110113"), 7);
  });

  it("EAN-8", () => {
    assert.equal(checkDigit("9638507"), 4);
  });

  it("元の配列を壊さない", () => {
    const digits = "490123456789";
    checkDigit(digits);
    assert.equal(digits, "490123456789");
  });
});

describe("describeBarcode", () => {
  it("正しい日本の JAN", () => {
    const info = describeBarcode("4901234567894");
    assert.equal(info.valid, true);
    assert.equal(info.kind, "JAN/EAN-13");
    assert.equal(info.country, "日本");
    assert.equal(info.makerCode, "4901234");
  });

  it("チェックディジットが違えば valid は false", () => {
    assert.equal(describeBarcode("4901234567890").valid, false);
  });

  it("海外のコードはメーカーコードを切り出さない", () => {
    const info = describeBarcode("0123456789012");
    assert.equal(info.country, "アメリカ・カナダ");
    assert.equal(info.makerCode, null);
  });

  it("桁数が合わないコード", () => {
    const info = describeBarcode("12345");
    assert.equal(info.valid, false);
    assert.equal(info.kind, "5桁のコード");
  });

  it("数字以外は落とす", () => {
    assert.equal(describeBarcode(" 4901-2345-67894 ").code, "4901234567894");
  });

  it("空なら何も分からない", () => {
    assert.deepEqual(describeBarcode(""), { code: "", valid: false, kind: null, country: null, makerCode: null });
  });
});

describe("barcodeSupported", () => {
  it("BarcodeDetector が無い環境では false", () => {
    // Node には window が無いので false になる。UI 側はこれでボタンを隠す
    assert.equal(barcodeSupported(), false);
  });
});
