import pytest

from oldwares.parsing import ParsedEntry
from oldwares.service import InputGroup, QuoteOptions, quote, search_page_url


def group(key, label, prices, title="ダウンジャケット L"):
    return InputGroup(key=key, label=label, entries=[ParsedEntry(title, p) for p in prices])


def two_groups(yahoo_prices, mercari_prices, **kw):
    return [group("yahoo", "ヤフオク", yahoo_prices, **kw), group("mercari", "メルカリ", mercari_prices, **kw)]


def test_blend_averages_each_sites_median():
    result = quote("ダウン", two_groups([1000, 2000, 3000], [5000, 6000, 7000]))
    assert result.blend.equal_weight_median == 4000  # (2000 + 6000) / 2
    assert result.blend.sources_used == ["yahoo", "mercari"]
    assert result.combined.count == 6


def test_equal_weight_is_not_swayed_by_sample_size():
    """件数の多い側に相場を引っ張られないこと（等ウェイト平均の目的）。"""
    result = quote("ダウン", two_groups([2000] * 50, [6000] * 4))
    assert result.blend.equal_weight_median == 4000
    assert result.blend.weighted_mean == pytest.approx(2296, abs=1)  # 件数加重だとヤフオク寄り


def test_one_site_only_still_works_but_warns():
    result = quote("ダウン", [group("yahoo", "ヤフオク", [5000, 6000, 7000, 8000, 9000])])
    assert result.blend.equal_weight_median == 7000
    assert any("片方のサイトだけ" in w for w in result.warnings)


def test_empty_group_does_not_break_the_other():
    result = quote("ダウン", [group("yahoo", "ヤフオク", []), group("mercari", "メルカリ", [5000, 6000, 7000])])
    assert result.combined.count == 3
    assert result.blend.sources_used == ["mercari"]


def test_bundle_listings_are_excluded_from_the_statistics():
    entries = [ParsedEntry("ダウン L", 5000) for _ in range(6)]
    entries.append(ParsedEntry("ノースフェイス まとめ売り 10点", 2000))
    result = quote("ダウン", [InputGroup("yahoo", "ヤフオク", entries=entries)])

    source = result.sources[0]
    assert source.stats.count == 6
    assert source.excluded_count == 1
    assert source.listings[-1].exclude_reason == "まとめ売り"


def test_outliers_are_removed_and_counted():
    prices = [5000, 5100, 5200, 5300, 5400, 5500, 5600, 5700, 900000]
    result = quote("ダウン", [group("yahoo", "ヤフオク", prices)])
    assert result.sources[0].outlier_count == 1
    assert result.sources[0].stats.max == 5700


def test_outlier_removal_can_be_turned_off():
    prices = [5000, 5100, 5200, 5300, 5400, 5500, 5600, 5700, 900000]
    result = quote("ダウン", [group("yahoo", "ヤフオク", prices)], QuoteOptions(remove_outliers=False))
    assert result.sources[0].outlier_count == 0
    assert result.sources[0].stats.max == 900000


def test_exclude_words_are_applied():
    entries = [ParsedEntry("ダウン L", 5000), ParsedEntry("ジュニア ダウン", 3000)]
    result = quote("ダウン", [InputGroup("yahoo", "ヤフオク", entries=entries)],
                   QuoteOptions(exclude_words=["ジュニア"]))
    assert result.sources[0].stats.count == 1


# --- 貼り付けテキストからの経路 ------------------------------------------
def test_quote_parses_pasted_text():
    yahoo = "ヌプシ A\n落札 9,800円\nヌプシ B\n落札 11,200円\n"
    mercari = "¥13,800\nヌプシ C\n¥12,400\nヌプシ D\n"
    result = quote("ヌプシ", [InputGroup("yahoo", "ヤフオク", yahoo), InputGroup("mercari", "メルカリ", mercari)])

    assert [s.parse["prices_found"] for s in result.sources] == [2, 2]
    assert result.blend.equal_weight_median == 11800
    assert result.histogram.series == ["ヤフオク", "メルカリ"]


def test_text_without_prices_reports_an_error_for_that_group_only():
    result = quote("ヌプシ", [
        InputGroup("yahoo", "ヤフオク", "ノースフェイス ヌプシ\nパタゴニア レトロX\n"),
        InputGroup("mercari", "メルカリ", "¥13,800\nヌプシ C\n¥12,400\nヌプシ D\n"),
    ])
    assert result.sources[0].error and "読み取れませんでした" in result.sources[0].error
    assert result.sources[1].stats.count == 2
    assert result.combined.count == 2
    assert any("ヤフオク" in w for w in result.warnings)


def test_no_input_at_all_warns():
    result = quote("ヌプシ", [InputGroup("yahoo", "ヤフオク", "")])
    assert result.combined.count == 0
    assert any("貼り付けて" in w for w in result.warnings)


def test_thin_sample_warns():
    result = quote("ヌプシ", two_groups([1000, 2000], [5000, 6000]))
    assert any("信頼度は低め" in w for w in result.warnings)


# --- 検索ページのリンク --------------------------------------------------
def test_search_page_urls_target_sold_items():
    yahoo = search_page_url("yahoo", "ヌプシ 700")
    mercari = search_page_url("mercari", "ヌプシ 700")
    assert "closedsearch" in yahoo                 # 落札相場ページ
    assert "status=sold_out" in mercari            # 売り切れのみ
    assert "%20700" in yahoo and "%20700" in mercari
    assert search_page_url("unknown", "x") == ""
