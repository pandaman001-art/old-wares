"""メルカリの「売り切れ」商品から実売価格を取得する。

メルカリの Web は SPA で、検索は内部 API (api.mercari.jp) を叩いている。
この API はリクエストごとに DPoP (RFC 9449) 署名ヘッダを要求するので、
ES256 の鍵をその場で生成して JWT を作る。鍵は保存せずプロセス内だけで使う。

status を STATUS_SOLD_OUT に絞っているため、取れるのは「実際に売れた価格」。
出品中の希望価格は混ざらない。
"""

from __future__ import annotations

import json
import time
import uuid
from urllib.parse import quote

import jwt
from cryptography.hazmat.primitives.asymmetric import ec

from ..http import build_client, polite_sleep, request_with_retry
from ..models import Listing
from .base import BaseSource, SourceError

SEARCH_ENDPOINT = "https://api.mercari.jp/v2/entities:search"
WEB_SEARCH_URL = "https://jp.mercari.com/search"
PER_PAGE = 120

# itemConditionId -> 表示名（メルカリの商品の状態）
CONDITION_LABELS = {
    1: "新品、未使用",
    2: "未使用に近い",
    3: "目立った傷や汚れなし",
    4: "やや傷や汚れあり",
    5: "傷や汚れあり",
    6: "全体的に状態が悪い",
}


class DpopSigner:
    """リクエストごとに DPoP proof JWT を作る。鍵はインスタンス生存中だけ有効。"""

    def __init__(self) -> None:
        self._key = ec.generate_private_key(ec.SECP256R1())
        public_numbers = self._key.public_key().public_numbers()
        self._jwk = {
            "crv": "P-256",
            "kty": "EC",
            "x": _b64u(public_numbers.x),
            "y": _b64u(public_numbers.y),
        }

    def proof(self, method: str, url: str) -> str:
        payload = {
            "iat": int(time.time()),
            "jti": str(uuid.uuid4()),
            "htu": url,
            "htm": method.upper(),
            "uuid": str(uuid.uuid4()),
        }
        return jwt.encode(
            payload,
            self._key,
            algorithm="ES256",
            headers={"typ": "dpop+jwt", "alg": "ES256", "jwk": self._jwk},
        )


def _b64u(number: int) -> str:
    import base64

    raw = number.to_bytes(32, "big")
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def build_search_payload(
    query: str,
    *,
    page_token: str = "",
    page_size: int = PER_PAGE,
    price_min: int | None = None,
    price_max: int | None = None,
    exclude_keyword: str = "",
    session_id: str | None = None,
) -> dict:
    """entities:search のリクエストボディ。売り切れのみに絞る。"""
    return {
        "userId": "",
        "pageSize": page_size,
        "pageToken": page_token,
        "searchSessionId": session_id or uuid.uuid4().hex,
        "indexRouting": "INDEX_ROUTING_UNSPECIFIED",
        "thumbnailTypes": [],
        "searchCondition": {
            "keyword": query,
            "excludeKeyword": exclude_keyword,
            "sort": "SORT_CREATED_TIME",
            "order": "ORDER_DESC",
            "status": ["STATUS_SOLD_OUT"],
            "sizeId": [],
            "categoryId": [],
            "brandId": [],
            "sellerId": [],
            "priceMin": price_min or 0,
            "priceMax": price_max or 0,
            "itemConditionId": [],
            "shippingPayerId": [],
            "shippingFromArea": [],
            "shippingMethod": [],
            "colorId": [],
            "hasCoupon": False,
            "attributes": [],
            "itemTypes": [],
            "skuIds": [],
            "shopIds": [],
            "excludeShippingMethodIds": [],
        },
        "defaultDatasets": ["DATASET_TYPE_MERCARI", "DATASET_TYPE_BEYOND"],
        "serviceFrom": "suruga",
        "withItemBrand": True,
        "withItemSize": False,
        "withItemPromotions": True,
        "withItemSizes": True,
        "withShopname": False,
        "useDynamicAttribute": True,
        "withSuggestedItems": True,
        "withOfferPricePromotion": True,
        "withProductSuggest": True,
        "withParentProducts": False,
        "withProductArticles": False,
        "withSearchConditionId": False,
    }


def parse_search_response(payload: dict) -> tuple[list[Listing], str]:
    """API レスポンスを (Listing のリスト, 次ページトークン) にする。"""
    items = payload.get("items") or []
    listings: list[Listing] = []
    for item in items:
        item_id = str(item.get("id") or "")
        if not item_id:
            continue
        try:
            price = int(item.get("price"))
        except (TypeError, ValueError):
            continue
        thumbnails = item.get("thumbnails") or []
        condition = item.get("itemConditionId")
        listings.append(
            Listing(
                source="mercari",
                item_id=item_id,
                title=str(item.get("name") or ""),
                price=price,
                url=f"https://jp.mercari.com/item/{item_id}",
                sold_at=None,  # 検索 API は売却日時を返さない
                condition=CONDITION_LABELS.get(_as_int(condition)),
                image_url=thumbnails[0] if thumbnails else None,
            )
        )
    meta = payload.get("meta") or {}
    next_token = str(payload.get("nextPageToken") or meta.get("nextPageToken") or "")
    return listings, next_token


def _as_int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


class MercariSource(BaseSource):
    key = "mercari"
    label = "メルカリ（売り切れ）"

    def search_url(self, query: str, *, price_min: int | None = None, price_max: int | None = None, **_) -> str:
        url = f"{WEB_SEARCH_URL}?keyword={quote(query)}&status=sold_out"
        if price_min:
            url += f"&price_min={price_min}"
        if price_max:
            url += f"&price_max={price_max}"
        return url

    def fetch(
        self,
        query: str,
        *,
        limit: int = 120,
        price_min: int | None = None,
        price_max: int | None = None,
        **_,
    ) -> list[Listing]:
        signer = DpopSigner()
        session_id = uuid.uuid4().hex
        listings: list[Listing] = []
        page_token = ""
        headers = {
            "Accept": "*/*",
            "Content-Type": "application/json",
            "Origin": "https://jp.mercari.com",
            "Referer": "https://jp.mercari.com/",
            "X-Platform": "web",
        }
        with build_client(timeout=self.timeout, headers=headers) as client:
            for page in range(max(1, -(-limit // PER_PAGE))):
                if page:
                    polite_sleep()
                body = build_search_payload(
                    query,
                    page_token=page_token,
                    page_size=min(PER_PAGE, limit),
                    price_min=price_min,
                    price_max=price_max,
                    session_id=session_id,
                )
                response = request_with_retry(
                    client,
                    "POST",
                    SEARCH_ENDPOINT,
                    json=body,
                    headers={"DPoP": signer.proof("POST", SEARCH_ENDPOINT)},
                )
                if response.status_code != 200:
                    raise SourceError(
                        f"メルカリ API が HTTP {response.status_code} を返しました"
                        + (
                            "（アクセス制限の可能性があります。時間をおいて再試行してください）"
                            if response.status_code in (403, 429)
                            else ""
                        )
                    )
                try:
                    payload = response.json()
                except json.JSONDecodeError as exc:
                    raise SourceError(f"メルカリ API の応答を解釈できません: {exc}") from exc

                page_listings, page_token = parse_search_response(payload)
                listings.extend(page_listings)
                if not page_token or not page_listings or len(listings) >= limit:
                    break
        return listings[:limit]
