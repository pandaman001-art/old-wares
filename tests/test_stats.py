import pytest

from oldwares import stats


def test_compute_basic_summary():
    result = stats.compute([1000, 2000, 3000, 4000, 5000])
    assert (result.count, result.min, result.max) == (5, 1000, 5000)
    assert result.median == 3000
    assert result.mean == 3000
    assert result.p25 == 2000 and result.p75 == 4000
    assert result.iqr == 2000


def test_compute_empty():
    result = stats.compute([])
    assert result.count == 0 and result.median is None and result.iqr is None


def test_percentile_interpolates():
    values = [10, 20, 30, 40]
    assert stats.percentile(values, 0.5) == 25.0
    assert stats.percentile(values, 0.25) == 17.5


def test_iqr_bounds_needs_enough_samples():
    assert stats.iqr_bounds([1, 2, 3]) is None
    assert stats.iqr_bounds([100] * 20) is None  # ばらつきゼロなら除去しない


def test_split_outliers_drops_far_values():
    prices = [1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 900000]
    kept, dropped = stats.split_outliers(prices)
    assert dropped == [900000]
    assert len(kept) == 8


def test_split_outliers_never_empties_the_set():
    prices = [1, 1, 1, 1, 1, 1, 1, 999999]
    kept, _ = stats.split_outliers(prices)
    assert kept


@pytest.mark.parametrize("raw,expected", [(1, 1), (3, 5), (237, 250), (1001, 2000), (0, 1)])
def test_nice_step(raw, expected):
    assert stats.nice_step(raw) == expected


def test_histogram_bins_cover_every_value():
    hist = stats.histogram({"a": [1000, 2000, 9000], "b": [1500, 8000]})
    assert hist.series == ["a", "b"]
    assert hist.edges[0] <= 1000 and hist.edges[-1] >= 9000
    assert sum(sum(row) for row in hist.counts) == 5
    assert len(hist.counts) == len(hist.edges) - 1


def test_histogram_handles_single_value():
    hist = stats.histogram({"a": [5000, 5000]})
    assert sum(sum(row) for row in hist.counts) == 2


def test_histogram_empty():
    assert stats.histogram({"a": []}).counts == []
