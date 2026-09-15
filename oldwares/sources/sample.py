"""ネットワークなしで UI と統計を確認するためのデモ用データ源。

外部サイトには一切アクセスしない。検索語から決まる擬似乱数で
それらしい価格分布（まとめ売りや外れ値も含む）を作る。
"""

from __future__ import annotations

import hashlib
import random
from datetime import date, timedelta

from ..models import Listing
from .base import BaseSource

CONDITIONS = ["新品、未使用", "未使用に近い", "目立った傷や汚れなし", "やや傷や汚れあり", "傷や汚れあり"]
NOISE_TITLES = ["まとめ売り 5点", "ジャンク品", "キッズサイズ", "レプリカ"]


def _rng(query: str, source: str) -> random.Random:
    seed = hashlib.sha256(f"{query}|{source}".encode("utf-8")).hexdigest()[:16]
    return random.Random(int(seed, 16))


class SampleSource(BaseSource):
    """demo:yahoo / demo:mercari のように取得元名を変えて 2 系統を再現する。"""

    def __init__(self, key: str, label: str, center: int = 9800, **kwargs):
        super().__init__(**kwargs)
        self.key = key
        self.label = label
        self.center = center

    def search_url(self, query: str, **_) -> str:
        return ""

    def fetch(self, query: str, *, limit: int = 120, **_) -> list[Listing]:
        rng = _rng(query, self.key)
        # 検索語ごとに中心価格をずらして、語を変えれば結果も変わるようにする
        center = self.center * rng.uniform(0.6, 1.8)
        count = min(limit, rng.randint(28, 60))
        today = date.today()
        listings: list[Listing] = []
        for i in range(count):
            if rng.random() < 0.08:
                title = f"{query} {rng.choice(NOISE_TITLES)}"
                price = int(center * rng.choice([0.05, 0.1, 6.0]))
            else:
                title = f"{query} {rng.choice(['M', 'L', 'XL', 'S'])}サイズ"
                price = int(rng.lognormvariate(0, 0.32) * center)
            listings.append(
                Listing(
                    source=self.key,
                    item_id=f"{self.key}-{i:03d}",
                    title=title,
                    price=max(100, price // 100 * 100),
                    url="",
                    sold_at=today - timedelta(days=rng.randint(0, 110)),
                    condition=rng.choice(CONDITIONS),
                )
            )
        return listings
