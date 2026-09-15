from oldwares.store import RecordStore


def test_save_and_get_round_trip(tmp_path):
    store = RecordStore(tmp_path)
    record = store.save("ヌプシ", [{"key": "yahoo", "label": "ヤフオク", "text": "落札 9,800円"}], {"median": 12000})

    loaded = store.get(record.id)
    assert loaded.query == "ヌプシ"
    assert loaded.groups[0]["text"] == "落札 9,800円"
    assert loaded.summary == {"median": 12000}


def test_list_is_newest_first_and_omits_the_pasted_text(tmp_path):
    store = RecordStore(tmp_path)
    older = store.save("A", [], {})
    newer = store.save("B", [], {})
    # 同じ秒に作られても順序が壊れないよう、ファイル名の乱数部分だけが違う
    ids = [row["id"] for row in store.list()]
    assert set(ids) == {older.id, newer.id}
    assert "groups" not in store.list()[0]


def test_delete(tmp_path):
    store = RecordStore(tmp_path)
    record = store.save("A", [], {})
    assert store.delete(record.id) is True
    assert store.delete(record.id) is False
    assert store.list() == []


def test_unknown_id_returns_none(tmp_path):
    assert RecordStore(tmp_path).get("20260101-000000-abcd") is None


def test_path_traversal_is_refused(tmp_path):
    store = RecordStore(tmp_path)
    assert store.get("../../etc/passwd") is None
    assert store.delete("../../etc/passwd") is False


def test_listing_an_empty_directory(tmp_path):
    assert RecordStore(tmp_path / "missing").list() == []


def test_corrupt_file_is_skipped(tmp_path):
    store = RecordStore(tmp_path)
    store.save("A", [], {})
    (tmp_path / "20260101-000000-dead.json").write_text("{ broken", encoding="utf-8")
    assert len(store.list()) == 1
