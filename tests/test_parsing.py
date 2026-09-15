import pytest

from oldwares.parsing import extract_price, parse_pasted_text

YAHOO_PASTE = """検索結果 1,234件
THE NORTH FACE ヌプシ 700 ダウンジャケット L ブラック
即決 32,000円
落札 18,500円
2026年9月1日
パタゴニア レトロX フリース M 2016
落札 24,800円
2026年8月30日
"""

MERCARI_PASTE = """¥12,800
ノースフェイス ヌプシ 700 Lサイズ
送料込み
SOLD
¥9,500
ノースフェイス ライトジャケット M
送料込み
"""


def prices(text):
    return [e.price for e in parse_pasted_text(text).entries]


def titles(text):
    return [e.title for e in parse_pasted_text(text).entries]


# --- 金額の読み取り ------------------------------------------------------
@pytest.mark.parametrize(
    "line,expected",
    [
        ("¥12,800", 12800),
        ("12,800円", 12800),
        ("￥12,800", None),   # 正規化前の全角記号は _clean を通して初めて読める
        ("12800円", 12800),
        ("送料込み", None),
    ],
)
def test_extract_price_forms(line, expected):
    assert extract_price(line) == expected


def test_extract_price_prefers_the_winning_bid_over_buy_it_now():
    assert extract_price("即決 32,000円 落札 18,500円") == 18500


def test_extract_price_skips_a_one_yen_start():
    assert extract_price("1円スタート 現在 18,500円") == 18500


# --- ヤフオク形式 --------------------------------------------------------
def test_yahoo_paste_takes_only_the_winning_bids():
    report = parse_pasted_text(YAHOO_PASTE)
    assert report.mode == "flow"
    assert [e.price for e in report.entries] == [18500, 24800]  # 即決 32,000円 は入らない
    assert report.entries[0].title == "THE NORTH FACE ヌプシ 700 ダウンジャケット L ブラック"
    assert report.untitled == 0


def test_inline_layout_strips_the_price_and_date_from_the_title():
    text = "THE NORTH FACE ヌプシ 700 L 18,500円 2026年9月1日\nパタゴニア レトロX M ¥24,800 2026/08/30\n"
    report = parse_pasted_text(text)
    assert [e.price for e in report.entries] == [18500, 24800]
    assert report.entries[0].title == "THE NORTH FACE ヌプシ 700 L"
    assert report.entries[1].title == "パタゴニア レトロX M"


def test_a_number_in_the_title_is_not_read_as_a_price():
    report = parse_pasted_text("ノースフェイス ヌプシ 700 1996年モデル\n落札 18,500円\n")
    assert [e.price for e in report.entries] == [18500]


# --- メルカリ形式（価格が商品名より前） ----------------------------------
def test_mercari_paste_pairs_price_with_the_following_title():
    report = parse_pasted_text(MERCARI_PASTE)
    assert [e.price for e in report.entries] == [12800, 9500]
    assert titles(MERCARI_PASTE) == ["ノースフェイス ヌプシ 700 Lサイズ", "ノースフェイス ライトジャケット M"]
    assert "送料込み" in report.ignored_samples


def test_each_title_is_paired_with_one_price():
    text = "¥1,000\nコートA\n¥2,000\nコートB\n¥3,000\nコートC\n"
    report = parse_pasted_text(text)
    assert [(e.price, e.title) for e in report.entries] == [
        (1000, "コートA"), (2000, "コートB"), (3000, "コートC"),
    ]


# --- 表形式 --------------------------------------------------------------
def test_csv_paste():
    report = parse_pasted_text("タイトル,価格\nノースフェイス ヌプシ L,18500\nパタゴニア レトロX M,24800\n")
    assert report.mode == "table"
    assert [(e.title, e.price) for e in report.entries] == [
        ("ノースフェイス ヌプシ L", 18500), ("パタゴニア レトロX M", 24800),
    ]


def test_tsv_paste():
    report = parse_pasted_text("ノースフェイス ヌプシ L\t18,500円\nパタゴニア レトロX M\t24,800円\n")
    assert report.mode == "table"
    assert [e.price for e in report.entries] == [18500, 24800]


def test_thousands_separators_do_not_make_it_a_table():
    assert parse_pasted_text(YAHOO_PASTE).mode == "flow"


# --- 価格だけの貼り付け --------------------------------------------------
def test_bare_numbers_are_prices_when_no_currency_marker_appears():
    report = parse_pasted_text("18500\n24800\n9800\n")
    assert [e.price for e in report.entries] == [18500, 24800, 9800]
    assert report.untitled == 3


def test_bare_numbers_are_ignored_when_the_paste_uses_currency_markers():
    # 「700」はサイズ表記であって価格ではない
    report = parse_pasted_text("ノースフェイス ヌプシ\n700\n¥18,500\n")
    assert [e.price for e in report.entries] == [18500]


# --- 端のケース ----------------------------------------------------------
def test_empty_text():
    report = parse_pasted_text("   \n\n")
    assert report.entries == [] and report.lines == 0


def test_text_without_any_price():
    report = parse_pasted_text("ノースフェイス ヌプシ\nパタゴニア レトロX\n")
    assert report.entries == [] and report.prices_found == 0


def test_full_width_characters_are_normalized():
    report = parse_pasted_text("ノースフェイス Ｌサイズ\n￥１２，８００\n")
    assert [e.price for e in report.entries] == [12800]
