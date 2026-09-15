"""ヤフオク「落札相場検索」から実際の落札価格を取得する。

落札相場ページは過去 120 日ぶんの落札価格を公開している。
出品中の希望価格ではなく実売価格なので、相場の基準として最も素直。

HTML 構造は予告なく変わるため、パーサは
  1) Product__* クラスを使う想定の経路
  2) 「オークション詳細へのリンク + 近くの金額」を拾う総当たり経路
の二段構えにしてある。1 が空振りしても 2 が拾えれば動く。
"""

from __future__ import annotations

import re
from datetime import date
from urllib.parse import urlencode

from bs4 import BeautifulSoup

from ..http import build_client, polite_sleep, request_with_retry
from ..models import Listing
from .base import BaseSource, SourceError

SEARCH_ENDPOINT = "https://auctions.yahoo.co.jp/closedsearch/closedsearch"
ITEM_URL_RE = re.compile(r"auctions\.yahoo\.co\.jp/jp/auction/([A-Za-z0-9]+)")
PRICE_RE = re.compile(r"(?:¥|￥)?\s*([0-9][0-9,]*)\s*円?")
# 保険の経路では「¥1,234」「1,234円」のように通貨記号が付いた数字だけを金額とみなす
CURRENCY_PRICE_RE = re.compile(r"(?:¥|￥)\s*([0-9][0-9,]*)|([0-9][0-9,]*)\s*円")
DATE_RE = re.compile(r"(\d{4})[./年-](\d{1,2})[./月-](\d{1,2})")
PER_PAGE = 100


def _parse_price(text: str) -> int | None:
    if not text:
        return None
    match = PRICE_RE.search(text.replace(" ", ""))
    if not match:
        return None
    try:
        return int(match.group(1).replace(",", ""))
    except ValueError:
        return None


def _parse_date(text: str) -> date | None:
    match = DATE_RE.search(text or "")
    if not match:
        return None
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


def _price_from_product(node) -> int | None:
    """商品ブロックから落札価格を選ぶ。「落札」ラベルつきの金額を優先する。"""
    candidates = node.select(".Product__priceValue, .Product__price, [class*=priceValue]")
    fallback: int | None = None
    for candidate in candidates:
        price = _parse_price(candidate.get_text(" ", strip=True))
        if price is None:
            continue
        # 「即決」「開始」価格ではなく落札価格を採りたい
        context = " ".join(
            sibling.get_text(" ", strip=True)
            for sibling in (candidate.parent.find_all(True) if candidate.parent else [])
        )
        classes = " ".join(candidate.get("class") or [])
        if "落札" in context or "落札" in classes:
            return price
        if fallback is None:
            fallback = price
    return fallback


def parse_closed_search(html: str) -> list[Listing]:
    """落札相場ページの HTML を Listing のリストにする。"""
    soup = BeautifulSoup(html, "lxml")
    listings = _parse_structured(soup)
    if not listings:
        listings = _parse_generic(soup)
    return listings


def _parse_structured(soup: BeautifulSoup) -> list[Listing]:
    listings: list[Listing] = []
    for node in soup.select("li.Product, li[class*='Product'], div.Product"):
        link = node.select_one("a.Product__titleLink") or node.find(
            "a", href=ITEM_URL_RE
        )
        if not link or not link.get("href"):
            continue
        match = ITEM_URL_RE.search(link["href"])
        if not match:
            continue
        price = _price_from_product(node)
        if price is None:
            continue
        title_node = node.select_one(".Product__title") or link
        time_node = node.select_one(".Product__time, [class*='Product__time']")
        image = node.find("img")
        listings.append(
            Listing(
                source="yahoo",
                item_id=match.group(1),
                title=title_node.get_text(" ", strip=True),
                price=price,
                url=link["href"].split("?")[0],
                sold_at=_parse_date(time_node.get_text(" ", strip=True) if time_node else ""),
                image_url=(image.get("src") or image.get("data-src")) if image else None,
            )
        )
    return listings


def _parse_generic(soup: BeautifulSoup) -> list[Listing]:
    """クラス名に依存せず、詳細リンクの近傍から金額を拾う保険の経路。"""
    listings: list[Listing] = []
    seen: set[str] = set()
    for link in soup.find_all("a", href=ITEM_URL_RE):
        match = ITEM_URL_RE.search(link["href"])
        if not match or match.group(1) in seen:
            continue
        title = link.get_text(" ", strip=True)
        if not title:
            continue
        node = link
        price: int | None = None
        # リンクから 4 階層まで遡り、最初に見つかった金額を落札価格とみなす。
        # タイトル中の数字を拾わないよう、タイトル部分は除いてから照合する。
        for _ in range(4):
            node = node.parent
            if node is None:
                break
            text = node.get_text(" ", strip=True).replace(title, " ", 1)
            found = CURRENCY_PRICE_RE.search(text)
            if found:
                price = int((found.group(1) or found.group(2)).replace(",", ""))
                break
        if not price:
            continue
        seen.add(match.group(1))
        listings.append(
            Listing(
                source="yahoo",
                item_id=match.group(1),
                title=title,
                price=price,
                url=link["href"].split("?")[0],
                sold_at=_parse_date(node.get_text(" ", strip=True) if node else ""),
            )
        )
    return listings


class YahooAuctionSource(BaseSource):
    key = "yahoo"
    label = "ヤフオク（落札相場）"

    def search_url(self, query: str, *, price_min: int | None = None, price_max: int | None = None, **_) -> str:
        return f"{SEARCH_ENDPOINT}?{urlencode(self._params(query, 1, price_min, price_max))}"

    @staticmethod
    def _params(query: str, offset: int, price_min: int | None, price_max: int | None) -> dict:
        params: dict[str, str | int] = {
            "p": query,
            "va": query,
            "b": offset,
            "n": PER_PAGE,
            "s1": "end",   # 終了日時順
            "o1": "d",     # 新しい順
        }
        if price_min:
            params["aucminprice"] = price_min
        if price_max:
            params["aucmaxprice"] = price_max
        return params

    def fetch(
        self,
        query: str,
        *,
        limit: int = 120,
        price_min: int | None = None,
        price_max: int | None = None,
        **_,
    ) -> list[Listing]:
        listings: list[Listing] = []
        pages = max(1, -(-limit // PER_PAGE))
        with build_client(timeout=self.timeout) as client:
            for page in range(pages):
                if page:
                    polite_sleep()
                params = self._params(query, page * PER_PAGE + 1, price_min, price_max)
                response = request_with_retry(client, "GET", SEARCH_ENDPOINT, params=params)
                if response.status_code != 200:
                    if page == 0:
                        raise SourceError(f"ヤフオクが HTTP {response.status_code} を返しました")
                    break
                page_listings = parse_closed_search(response.text)
                if not page_listings:
                    if page == 0 and "該当する商品は見つかりませんでした" not in response.text:
                        raise SourceError(
                            "落札データを 1 件も抽出できませんでした。"
                            "ページ構造が変わった可能性があります"
                            "（OLDWARES_DEBUG_DIR を設定すると HTML を保存できます）"
                        )
                    break
                listings.extend(page_listings)
                if len(page_listings) < PER_PAGE or len(listings) >= limit:
                    break
        return listings[:limit]
