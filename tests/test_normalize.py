from oldwares import normalize
from oldwares.models import Listing


def listing(title, price=5000):
    return Listing(source="yahoo", item_id="1", title=title, price=price)


def test_normalize_text_folds_widths_and_spaces():
    assert normalize.normalize_text("Ｌサイズ　　ダウン") == "Lサイズ ダウン"


def test_bundle_and_junk_are_excluded():
    assert normalize.exclusion_reason(listing("古着 まとめ売り 10点")) == "まとめ売り"
    assert normalize.exclusion_reason(listing("ジャンク品 ダウン")) == "難あり"


def test_setup_is_not_treated_as_a_bundle():
    assert normalize.exclusion_reason(listing("スーツ セットアップ 美品")) is None
    assert normalize.exclusion_reason(listing("Tシャツ 3枚セット")) == "セット売り"


def test_condition_wording_is_not_excluded():
    # 「傷や汚れあり」はメルカリの正規の状態表記なので落とさない
    assert normalize.exclusion_reason(listing("ダウン やや傷や汚れあり L")) is None


def test_price_guards():
    assert "未満" in normalize.exclusion_reason(listing("ダウン", price=100))
    assert "超" in normalize.exclusion_reason(listing("ダウン", price=9_000_000))


def test_query_terms_disable_matching_default_rules():
    rules = normalize.default_rules_for_query("キッズ ダウン")
    assert normalize.exclusion_reason(listing("キッズ ダウン 120"), default_rules=rules) is None
    # 検索語に含まれない他のルールは生きている
    assert normalize.exclusion_reason(listing("まとめ売り"), default_rules=rules) == "まとめ売り"


def test_extra_exclude_words():
    extra = normalize.compile_extra_excludes(["ジュニア"])
    assert normalize.exclusion_reason(listing("ジュニア ダウン"), extra_rules=extra).startswith("除外語")


def test_apply_filters_marks_listings():
    rows = [listing("ダウン L"), listing("まとめ売り")]
    normalize.apply_filters(rows, query="ダウン")
    assert rows[0].excluded is False
    assert rows[1].excluded is True and rows[1].exclude_reason == "まとめ売り"


def test_dedupe_by_source_and_id():
    rows = [listing("a"), listing("b")]
    assert len(normalize.dedupe(rows)) == 1
