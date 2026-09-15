import csv
import io

import pytest
from fastapi.testclient import TestClient

from oldwares.api import app

DEMO = "demo-yahoo,demo-mercari"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("OLDWARES_CACHE_DIR", str(tmp_path))
    monkeypatch.setenv("OLDWARES_CACHE_TTL", "0")
    return TestClient(app)


def test_health(client):
    assert client.get("/api/health").json()["status"] == "ok"


def test_index_serves_the_ui(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "old-wares" in response.text


def test_sources_lists_live_and_demo(client):
    body = client.get("/api/sources").json()
    keys = {s["key"] for s in body["sources"]}
    assert {"yahoo", "mercari", "demo-yahoo", "demo-mercari"} <= keys
    assert body["default"] == ["yahoo", "mercari"]


def test_search_returns_stats_for_both_sources(client):
    body = client.get("/api/search", params={"q": "ノースフェイス ヌプシ", "sources": DEMO}).json()
    assert [s["source"] for s in body["sources"]] == ["demo-yahoo", "demo-mercari"]
    assert body["combined"]["count"] > 0
    assert body["blend"]["equal_weight_median"] > 0
    assert body["histogram"]["series"] and body["histogram"]["counts"]
    assert all(s["ok"] for s in body["sources"])


def test_search_requires_a_query(client):
    assert client.get("/api/search").status_code == 422


def test_search_rejects_unknown_sources(client):
    response = client.get("/api/search", params={"q": "ダウン", "sources": "rakuma"})
    assert response.status_code == 400
    assert "rakuma" in response.json()["detail"]


def test_search_rejects_inverted_price_range(client):
    response = client.get(
        "/api/search", params={"q": "ダウン", "sources": DEMO, "price_min": 9000, "price_max": 1000}
    )
    assert response.status_code == 400


def test_search_respects_the_limit_ceiling(client):
    assert client.get("/api/search", params={"q": "ダウン", "limit": 9999}).status_code == 422


def test_price_filter_narrows_the_result(client):
    params = {"q": "ダウン", "sources": DEMO, "price_min": 8000}
    body = client.get("/api/search", params=params).json()
    used = [x for s in body["sources"] for x in s["listings"] if not x["excluded"]]
    assert used and all(x["price"] >= 8000 for x in used)


def test_csv_export_has_a_header_and_only_used_rows(client):
    response = client.get("/api/export.csv", params={"q": "ダウン", "sources": DEMO})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    text = response.text.lstrip("﻿")
    rows = list(csv.reader(io.StringIO(text)))
    assert rows[0][:3] == ["取得元", "タイトル", "価格"]
    assert len(rows) > 1
    assert all(row[6] == "yes" for row in rows[1:])


def test_csv_export_can_include_excluded_rows(client):
    params = {"q": "ダウン", "sources": DEMO, "include_excluded": "true"}
    rows = list(csv.reader(io.StringIO(client.get("/api/export.csv", params=params).text.lstrip("﻿"))))
    assert any(row[6] == "no" for row in rows[1:])


def test_cache_clear_endpoint(client):
    assert "removed" in client.post("/api/cache/clear").json()
