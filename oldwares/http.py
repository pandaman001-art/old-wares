"""HTTP クライアントの共通設定。

相手サイトに迷惑をかけないため、
 - ブラウザ相当の User-Agent を名乗る
 - ページ取得の間に必ずウェイトを入れる
 - 429/5xx は指数バックオフで数回だけ再試行する
を全取得元で共通化する。
"""

from __future__ import annotations

import os
import random
import time

import httpx

DEFAULT_USER_AGENT = os.environ.get(
    "OLDWARES_USER_AGENT",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
)

# 連続ページ取得の最小間隔（秒）
DEFAULT_DELAY = float(os.environ.get("OLDWARES_REQUEST_DELAY", "1.2"))
MAX_RETRIES = 3
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})


def build_client(timeout: float = 20.0, headers: dict[str, str] | None = None) -> httpx.Client:
    base_headers = {
        "User-Agent": DEFAULT_USER_AGENT,
        "Accept-Language": "ja,en-US;q=0.8,en;q=0.7",
    }
    base_headers.update(headers or {})
    return httpx.Client(
        timeout=timeout,
        headers=base_headers,
        follow_redirects=True,
    )


def request_with_retry(
    client: httpx.Client,
    method: str,
    url: str,
    *,
    max_retries: int = MAX_RETRIES,
    **kwargs,
) -> httpx.Response:
    """429/5xx とネットワーク例外に対してのみ再試行する。4xx は即座に返す。"""
    last_exc: Exception | None = None
    for attempt in range(max_retries):
        try:
            response = client.request(method, url, **kwargs)
        except httpx.HTTPError as exc:
            last_exc = exc
        else:
            if response.status_code not in RETRY_STATUSES:
                return response
            last_exc = httpx.HTTPStatusError(
                f"HTTP {response.status_code}", request=response.request, response=response
            )
        if attempt < max_retries - 1:
            backoff = (2**attempt) + random.uniform(0, 0.4)
            time.sleep(backoff)
    assert last_exc is not None
    raise last_exc


def polite_sleep(delay: float = DEFAULT_DELAY) -> None:
    if delay > 0:
        time.sleep(delay)
