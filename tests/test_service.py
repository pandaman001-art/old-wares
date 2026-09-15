import pytest

from oldwares import service
from oldwares.models import Listing, SourceResult
from oldwares.service import SearchOptions, search


class FakeSource:
    """build_source を差し替えて、決まった出品リストを返させる。"""

    def __init__(self, key, label, listings=None, error=None):
        self.key, self.label = key, label
        self._listings, self._error = listings or [], error

    def collect(self, query, **_):
        return SourceResult(
            source=self.key, label=self.label,
            listings=list(self._listings), error=self._error,
        )


def make(source, prices, title="ダウンジャケット L"):
    return [
        Listing(source=source, item_id=f"{source}-{i}", title=title, price=p, url="")
        for i, p in enumerate(prices)
    ]


@pytest.fixture
def fake_sources(monkeypatch):
    registry = {}

    def build(key, **_):
        if key not in registry:
            raise KeyError(key)
        return registry[key]

    monkeypatch.setattr(service, "build_source", build)
    return registry


def test_blend_averages_each_sources_median(fake_sources):
    fake_sources["yahoo"] = FakeSource("yahoo", "ヤフオク", make("yahoo", [1000, 2000, 3000]))
    fake_sources["mercari"] = FakeSource("mercari", "メルカリ", make("mercari", [5000, 6000, 7000]))
    result = search("ダウン", SearchOptions(cache_ttl=0))

    assert result.blend.equal_weight_median == 4000  # (2000 + 6000) / 2
    assert result.blend.sources_used == ["yahoo", "mercari"]
    assert result.combined.count == 6
    assert result.combined.median == 4000


def test_equal_weight_is_not_swayed_by_sample_size(fake_sources):
    """件数の多い側に相場を引っ張られないこと（等ウェイト平均の目的）。"""
    fake_sources["yahoo"] = FakeSource("yahoo", "ヤフオク", make("yahoo", [2000] * 50))
    fake_sources["mercari"] = FakeSource("mercari", "メルカリ", make("mercari", [6000] * 4))
    result = search("ダウン", SearchOptions(cache_ttl=0))

    assert result.blend.equal_weight_median == 4000
    assert result.blend.weighted_mean == pytest.approx(2296, abs=1)  # 件数加重だとヤフオク寄り


def test_one_source_failing_does_not_break_the_other(fake_sources):
    fake_sources["yahoo"] = FakeSource("yahoo", "ヤフオク", error="HTTP 503")
    fake_sources["mercari"] = FakeSource("mercari", "メルカリ", make("mercari", [5000, 6000, 7000]))
    result = search("ダウン", SearchOptions(cache_ttl=0))

    assert result.combined.count == 3
    assert result.blend.equal_weight_median == 6000
    assert result.blend.sources_used == ["mercari"]
    assert any("HTTP 503" in w for w in result.warnings)


def test_bundle_listings_are_excluded_from_the_statistics(fake_sources):
    listings = make("yahoo", [5000] * 6) + make("yahoo", [2000], title="まとめ売り 10点")
    listings[-1].item_id = "bundle"
    fake_sources["yahoo"] = FakeSource("yahoo", "ヤフオク", listings)
    result = search("ダウン", SearchOptions(sources=("yahoo",), cache_ttl=0))

    source = result.sources[0]
    assert source.stats.count == 6
    assert source.excluded_count == 1
    assert next(x for x in source.listings if x.item_id == "bundle").exclude_reason == "まとめ売り"


def test_outliers_are_removed_and_counted(fake_sources):
    prices = [5000, 5100, 5200, 5300, 5400, 5500, 5600, 5700, 900000]
    fake_sources["yahoo"] = FakeSource("yahoo", "ヤフオク", make("yahoo", prices))
    result = search("ダウン", SearchOptions(sources=("yahoo",), cache_ttl=0))

    assert result.sources[0].outlier_count == 1
    assert result.sources[0].stats.max == 5700


def test_outlier_removal_can_be_turned_off(fake_sources):
    prices = [5000, 5100, 5200, 5300, 5400, 5500, 5600, 5700, 900000]
    fake_sources["yahoo"] = FakeSource("yahoo", "ヤフオク", make("yahoo", prices))
    result = search("ダウン", SearchOptions(sources=("yahoo",), remove_outliers=False, cache_ttl=0))

    assert result.sources[0].outlier_count == 0
    assert result.sources[0].stats.max == 900000


def test_empty_query_short_circuits(fake_sources):
    result = search("   ", SearchOptions(cache_ttl=0))
    assert result.sources == [] and result.warnings


def test_no_data_produces_a_warning(fake_sources):
    fake_sources["yahoo"] = FakeSource("yahoo", "ヤフオク", [])
    result = search("存在しない語", SearchOptions(sources=("yahoo",), cache_ttl=0))
    assert result.combined.count == 0
    assert any("見つかりません" in w for w in result.warnings)


def test_histogram_series_follow_the_sources(fake_sources):
    fake_sources["yahoo"] = FakeSource("yahoo", "ヤフオク", make("yahoo", [1000, 2000, 3000]))
    fake_sources["mercari"] = FakeSource("mercari", "メルカリ", make("mercari", [5000, 6000]))
    result = search("ダウン", SearchOptions(cache_ttl=0))

    assert result.histogram.series == ["ヤフオク", "メルカリ"]
    assert sum(sum(row) for row in result.histogram.counts) == 5


def test_limit_is_clamped():
    assert SearchOptions(limit=10_000).clamped_limit() == service.MAX_LIMIT
    assert SearchOptions(limit=0).clamped_limit() == 1
