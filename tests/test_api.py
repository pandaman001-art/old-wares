import pytest
from fastapi.testclient import TestClient

from oldwares.api import app

YAHOO = "ヌプシ A\n落札 9,800円\nヌプシ B\n落札 11,200円\nヌプシ C\n落札 10,500円\n"
MERCARI = "¥13,800\nヌプシ D\n¥12,400\nヌプシ E\n¥14,000\nヌプシ F\n"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("OLDWARES_DATA_DIR", str(tmp_path))
    return TestClient(app)


def body(**overrides):
    payload = {
        "query": "ヌプシ",
        "groups": [
            {"key": "yahoo", "label": "ヤフオク", "text": YAHOO},
            {"key": "mercari", "label": "メルカリ", "text": MERCARI},
        ],
    }
    payload.update(overrides)
    return payload


def test_health(client):
    assert client.get("/api/health").json()["status"] == "ok"


def test_index_serves_the_ui(client):
    response = client.get("/")
    assert response.status_code == 200 and "old-wares" in response.text


def test_groups_without_a_query_have_no_links(client):
    data = client.get("/api/groups").json()
    assert [g["key"] for g in data["groups"]] == ["yahoo", "mercari"]
    assert all(g["search_url"] == "" for g in data["groups"])


def test_groups_with_a_query_link_to_sold_listings(client):
    data = client.get("/api/groups", params={"q": "ヌプシ 700"}).json()
    urls = {g["key"]: g["search_url"] for g in data["groups"]}
    assert "closedsearch" in urls["yahoo"]
    assert "status=sold_out" in urls["mercari"]


def test_quote_returns_stats_for_both_inputs(client):
    data = client.post("/api/quote", json=body()).json()
    assert [s["source"] for s in data["sources"]] == ["yahoo", "mercari"]
    assert data["combined"]["count"] == 6
    assert data["blend"]["equal_weight_median"] == 12150  # (10500 + 13800) / 2
    assert data["histogram"]["series"] and data["histogram"]["counts"]


def test_quote_rejects_an_empty_group_list(client):
    assert client.post("/api/quote", json=body(groups=[])).status_code == 400


def test_quote_rejects_an_inverted_price_range(client):
    payload = body(options={"price_min": 90000, "price_max": 1000})
    assert client.post("/api/quote", json=payload).status_code == 400


def test_quote_rejects_an_oversized_paste(client):
    payload = body(groups=[{"key": "yahoo", "label": "ヤフオク", "text": "x" * 400_001}])
    assert client.post("/api/quote", json=payload).status_code == 422


def test_quote_applies_the_price_floor(client):
    payload = body(options={"price_min": 12000})
    data = client.post("/api/quote", json=payload).json()
    used = [x for s in data["sources"] for x in s["listings"] if not x["excluded"]]
    assert used and all(x["price"] >= 12000 for x in used)


def test_quote_reports_unreadable_text_per_group(client):
    payload = body(groups=[{"key": "yahoo", "label": "ヤフオク", "text": "ノースフェイス ヌプシ\nパタゴニア"}])
    data = client.post("/api/quote", json=payload).json()
    assert data["sources"][0]["ok"] is False
    assert "読み取れませんでした" in data["sources"][0]["error"]


def test_quote_fills_in_the_default_label(client):
    payload = body(groups=[{"key": "yahoo", "text": YAHOO}])
    data = client.post("/api/quote", json=payload).json()
    assert data["sources"][0]["label"] == "ヤフオク（落札価格）"


# --- 保存した調査 --------------------------------------------------------
def test_record_lifecycle(client):
    assert client.get("/api/records").json()["records"] == []

    created = client.post("/api/records", json={
        "query": "ヌプシ",
        "groups": [{"key": "yahoo", "label": "ヤフオク", "text": YAHOO}],
        "summary": {"blend": {"equal_weight_median": 12000}},
    })
    assert created.status_code == 201
    record_id = created.json()["id"]

    listing = client.get("/api/records").json()["records"]
    assert len(listing) == 1 and listing[0]["query"] == "ヌプシ"

    detail = client.get(f"/api/records/{record_id}").json()
    assert detail["groups"][0]["text"] == YAHOO

    assert client.delete(f"/api/records/{record_id}").status_code == 200
    assert client.get("/api/records").json()["records"] == []


def test_missing_record_is_404(client):
    assert client.get("/api/records/20260101-000000-abcd").status_code == 404
    assert client.delete("/api/records/20260101-000000-abcd").status_code == 404


def test_record_id_with_a_path_traversal_is_404(client):
    assert client.get("/api/records/..%2F..%2Fetc%2Fpasswd").status_code == 404
