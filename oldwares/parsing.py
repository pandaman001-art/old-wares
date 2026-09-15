"""検索結果ページから貼り付けたテキストを、商品名と価格の組に変換する。

ヤフオクの落札相場ページやメルカリの検索結果をブラウザで開き、
一覧をドラッグしてコピーしたものをそのまま受け取る前提。
レイアウトはサイトごとに違うので、行の並びではなく
「金額らしい行」と「商品名らしい行」の距離で対応づける。

CSV / TSV を貼った場合はそちらのモードで読む。
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

# 金額の書き方。通貨記号か「円」が付いているものだけを金額として扱う
CURRENCY_AMOUNT_RE = re.compile(r"¥\s*([0-9][0-9,]*)|([0-9][0-9,]*)\s*円")
# 行まるごとが金額（「¥12,800」「12,800円」「12800」）
PRICE_ONLY_RE = re.compile(r"^¥?\s*([0-9][0-9,]*)\s*円?$")
# 「落札 18,500円」のようにラベルが直前に付く形
WINNING_BID_RE = re.compile(r"落札[^0-9¥]{0,6}(?:¥\s*([0-9][0-9,]*)|([0-9][0-9,]*)\s*円)")

# 商品名として採用しない、一覧ページの飾り
NOISE_RE = re.compile(
    r"^(?:送料|着払|いいね|ウォッチ|入札|残り|出品者?|並び替え|絞り込み|検索結果|該当|"
    r"前へ|次へ|ページ|すべて|カテゴリ|新着|おすすめ|広告|PR|SOLD|売り切れ|"
    r"即決|落札|開始価格|現在|税込|税抜|中古|新品|未使用|フォロー|もっと見る)"
    r"|^\d+\s*(?:日|時間|分)前"
    r"|^\d{4}[./年-]\d{1,2}"
    r"|^\d{1,2}[./月]\d{1,2}日?$"
    r"|^[\d,.\s%¥円件点個]+$"
)

# 落札価格ではない金額の行（これらは統計に入れない）
NON_FINAL_PRICE_RE = re.compile(r"^(?:即決|開始価格|開始|現在の?価格|現在|最低落札|希望価格)")
# 商品名の末尾に残る終了日・売却日
TRAILING_DATE_RE = re.compile(
    r"\s*(?:\d{4}[./年-]\d{1,2}[./月-]\d{1,2}日?|\d{1,2}[./月]\d{1,2}日?)\s*$"
)
# 「1,234」のような桁区切りのカンマ（表の区切りと区別するために取り除く）
THOUSANDS_COMMA_RE = re.compile(r"(?<=\d),(?=\d{3}(?!\d))")

# 明細としてありえない金額（1 円スタートの表示などを拾わないための下限）
MIN_PLAUSIBLE_PRICE = 300


@dataclass
class ParsedEntry:
    title: str
    price: int


@dataclass
class ParseReport:
    entries: list[ParsedEntry] = field(default_factory=list)
    mode: str = "flow"          # flow / table
    lines: int = 0              # 中身のある行数
    prices_found: int = 0
    untitled: int = 0           # 商品名を対応づけられなかった件数
    ignored_samples: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "mode": self.mode,
            "lines": self.lines,
            "prices_found": self.prices_found,
            "untitled": self.untitled,
            "ignored_samples": list(self.ignored_samples),
        }


def _clean(text: str) -> str:
    return unicodedata.normalize("NFKC", text or "").replace("￥", "¥")


def _to_int(raw: str) -> int | None:
    try:
        return int(raw.replace(",", ""))
    except (AttributeError, ValueError):
        return None


def extract_price(line: str) -> int | None:
    """1 行から代表となる金額を 1 つ選ぶ。

    「落札」ラベル付きの金額を最優先し、次いで下限以上で最初に出てくる金額を採る。
    「即決 32,000円 落札 18,500円」で即決を拾わないための順序。
    """
    winning = WINNING_BID_RE.search(line)
    if winning:
        value = _to_int(winning.group(1) or winning.group(2))
        if value is not None:
            return value

    fallback: int | None = None
    for match in CURRENCY_AMOUNT_RE.finditer(line):
        value = _to_int(match.group(1) or match.group(2))
        if value is None:
            continue
        if value >= MIN_PLAUSIBLE_PRICE:
            return value
        if fallback is None:
            fallback = value
    return fallback


def _looks_like_title(line: str) -> bool:
    if len(line) < 2 or NOISE_RE.search(line):
        return False
    # 数字と記号だけの行は商品名ではない
    return bool(re.search(r"[^\d\s,.\-¥円()（）]", line))


def _strip_prices(line: str) -> str:
    """商品名と同じ行にある金額と日付を取り除く。"""
    text = CURRENCY_AMOUNT_RE.sub(" ", line)
    text = TRAILING_DATE_RE.sub("", re.sub(r"\s{2,}", " ", text).strip())
    return text.strip(" 　-–—:：|/")


def _parse_table(lines: list[str]) -> list[ParsedEntry]:
    """タブ / カンマ区切りの表として読む。価格は右端の数値列。"""
    entries: list[ParsedEntry] = []
    for line in lines:
        fields = line.split("\t") if "\t" in line else line.split(",")
        fields = [f.strip().strip('"') for f in fields if f.strip()]
        if len(fields) < 2:
            continue
        price = None
        for field_text in reversed(fields):
            price = extract_price(field_text) or _to_int(field_text)
            if price:
                break
        if not price:
            continue
        title = next((f for f in fields if _looks_like_title(f)), "")
        entries.append(ParsedEntry(title=title, price=price))
    return entries


def _looks_like_table(lines: list[str]) -> bool:
    """タブ区切り、または桁区切り以外のカンマを含む行が過半なら表とみなす。"""
    if not lines:
        return False
    delimited = 0
    for line in lines:
        if "\t" in line or "," in THOUSANDS_COMMA_RE.sub("", line):
            delimited += 1
    return delimited >= max(2, (len(lines) + 1) // 2)


def parse_pasted_text(text: str) -> ParseReport:
    """貼り付けたテキストを明細に変換する。"""
    cleaned = _clean(text)
    lines = [line.strip() for line in cleaned.splitlines()]
    lines = [line for line in lines if line]
    report = ParseReport(lines=len(lines))
    if not lines:
        return report

    if _looks_like_table(lines):
        report.mode = "table"
        report.entries = _parse_table(lines)
        report.prices_found = len(report.entries)
        report.untitled = sum(1 for e in report.entries if not e.title)
        return report

    # --- 行の分類 ---------------------------------------------------------
    prices: list[tuple[int, int]] = []       # (行番号, 金額)
    titles: list[tuple[int, str]] = []       # (行番号, 商品名)
    ignored: list[str] = []
    for index, line in enumerate(lines):
        if NON_FINAL_PRICE_RE.match(line):
            # 即決・開始価格などは実際に売れた金額ではないので捨てる
            continue
        only = PRICE_ONLY_RE.match(line)
        if only:
            value = _to_int(only.group(1))
            # 通貨記号なしの裸の数字は、同じ貼り付けに通貨表記が無いときだけ金額扱い
            if value is not None and (("¥" in line or "円" in line) or "¥" not in cleaned and "円" not in cleaned):
                prices.append((index, value))
                continue
        inline = extract_price(line)
        # 「1円スタート」のような小さすぎる数字は金額ではなく商品名の一部として扱う
        if inline is not None and inline >= MIN_PLAUSIBLE_PRICE and ("¥" in line or "円" in line):
            prices.append((index, inline))
            rest = _strip_prices(line)
            if _looks_like_title(rest):
                titles.append((index, rest))
            continue
        if _looks_like_title(line):
            titles.append((index, line))
        elif len(ignored) < 5:
            ignored.append(line)

    report.prices_found = len(prices)
    report.ignored_samples = ignored

    # --- 金額と商品名の対応づけ ------------------------------------------
    used: set[int] = set()
    for line_no, price in prices:
        candidates = sorted(
            titles,
            # 同距離なら金額より前にある行を優先。未使用の商品名を先に使う
            key=lambda t: (t[0] in used, abs(t[0] - line_no), 0 if t[0] <= line_no else 1),
        )
        title = ""
        if candidates:
            chosen = candidates[0]
            title = chosen[1]
            used.add(chosen[0])
        if not title:
            report.untitled += 1
        report.entries.append(ParsedEntry(title=title, price=price))
    return report
