from datetime import date
from pathlib import Path

import jwt
import pytest

from oldwares.sources import build_source
from oldwares.sources.base import SourceError
from oldwares.sources.mercari import DpopSigner, build_search_payload, parse_search_response
from oldwares.sources.yahoo_auction import YahooAuctionSource, parse_closed_search

FIXTURES = Path(__file__).parent / "fixtures"


# --- ヤフオク -----------------------------------------------------------
def test_yahoo_structured_parser_prefers_the_winning_bid():
    listings = parse_closed_search((FIXTURES / "yahoo_closed_product.html").read_text("utf-8"))
    assert [x.item_id for x in listings] == ["x1111", "x2222"]  # 広告行は落ちる
    first = listings[0]
    assert first.price == 18_500  # 即決 32,000円 ではなく落札価格
    assert first.sold_at == date(2026, 9, 1)
    assert first.url == "https://page.auctions.yahoo.co.jp/jp/auction/x1111"
    assert first.image_url == "https://img.example/1.jpg"
    assert first.source == "yahoo"


def test_yahoo_generic_parser_is_used_when_classes_change():
    listings = parse_closed_search((FIXTURES / "yahoo_closed_generic.html").read_text("utf-8"))
    assert [(x.item_id, x.price) for x in listings] == [("y3333", 24_800), ("y4444", 12_300)]
    # タイトル中の「2016」「1998」を金額と取り違えていないこと
    assert listings[0].sold_at == date(2026, 8, 30)


def test_yahoo_parser_on_empty_page():
    assert parse_closed_search("<html><body>該当する商品は見つかりませんでした</body></html>") == []


def test_yahoo_search_url_carries_query_and_price_filter():
    url = YahooAuctionSource().search_url("ヌプシ", price_min=3000, price_max=40000)
    assert "closedsearch" in url and "aucminprice=3000" in url and "aucmaxprice=40000" in url


# --- メルカリ -----------------------------------------------------------
def test_dpop_proof_is_an_es256_jwt_with_an_embedded_jwk():
    token = DpopSigner().proof("POST", "https://api.mercari.jp/v2/entities:search")
    header = jwt.get_unverified_header(token)
    assert header["typ"] == "dpop+jwt" and header["alg"] == "ES256"
    assert header["jwk"]["crv"] == "P-256" and header["jwk"]["kty"] == "EC"
    claims = jwt.decode(token, options={"verify_signature": False})
    assert claims["htm"] == "POST"
    assert claims["htu"] == "https://api.mercari.jp/v2/entities:search"


def test_search_payload_requests_sold_items_only():
    payload = build_search_payload("ヌプシ", price_min=3000)
    condition = payload["searchCondition"]
    assert condition["status"] == ["STATUS_SOLD_OUT"]
    assert condition["keyword"] == "ヌプシ"
    assert condition["priceMin"] == 3000 and condition["priceMax"] == 0


def test_parse_search_response_skips_malformed_items():
    listings, token = parse_search_response(
        {
            "items": [
                {"id": "m1", "name": "ダウン", "price": "12800", "itemConditionId": 3,
                 "thumbnails": ["https://img/a.jpg"]},
                {"id": "m2", "name": "価格なし", "price": None},
                {"name": "IDなし", "price": "100"},
            ],
            "meta": {"nextPageToken": "next"},
        }
    )
    assert [x.item_id for x in listings] == ["m1"]
    assert listings[0].price == 12_800
    assert listings[0].condition == "目立った傷や汚れなし"
    assert listings[0].url == "https://jp.mercari.com/item/m1"
    assert token == "next"


# --- レジストリ / 共通処理 ----------------------------------------------
def test_unknown_source_key():
    with pytest.raises(KeyError):
        build_source("ヤフーショッピング")


def test_collect_turns_failures_into_a_result_instead_of_raising():
    source = build_source("demo-yahoo")
    source.fetch = lambda *a, **k: (_ for _ in ()).throw(SourceError("取得失敗"))
    result = source.collect("ダウン", limit=10)
    assert result.ok is False and result.error == "取得失敗"
    assert result.listings == []


def test_collect_uses_the_cache_on_the_second_call(tmp_path):
    from oldwares.cache import Cache

    cache = Cache(tmp_path, ttl=600)
    first = build_source("demo-yahoo", cache=cache).collect("ダウン", limit=20)
    second = build_source("demo-yahoo", cache=cache).collect("ダウン", limit=20)
    assert first.cached is False and second.cached is True
    assert [x.price for x in first.listings] == [x.price for x in second.listings]
    assert second.listings[0].sold_at == first.listings[0].sold_at  # 日付が復元されている
