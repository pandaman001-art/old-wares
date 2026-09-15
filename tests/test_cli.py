from oldwares.cli import main

YAHOO = "ヌプシ A\n落札 9,800円\nヌプシ B\n落札 11,200円\nヌプシ C\n落札 10,500円\n"
MERCARI = "¥13,800\nヌプシ D\n¥12,400\nヌプシ E\n¥14,000\nヌプシ F\n"


def write(tmp_path, name, text):
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    return str(path)


def test_prints_a_summary(tmp_path, capsys):
    code = main(["ヌプシ", "--yahoo", write(tmp_path, "y.txt", YAHOO),
                 "--mercari", write(tmp_path, "m.txt", MERCARI)])
    out = capsys.readouterr().out
    assert code == 0
    assert "相場（両サイト中央値の平均）: ¥12,150" in out
    assert "ヤフオク（落札価格）" in out


def test_json_output_is_parseable(tmp_path, capsys):
    import json

    main(["ヌプシ", "--yahoo", write(tmp_path, "y.txt", YAHOO), "--json"])
    data = json.loads(capsys.readouterr().out)
    assert data["combined"]["count"] == 3
    assert data["sources"][0]["source"] == "yahoo"


def test_urls_mode_does_not_need_input(capsys):
    assert main(["ヌプシ 700", "--urls"]) == 0
    out = capsys.readouterr().out
    assert "closedsearch" in out and "status=sold_out" in out


def test_missing_input_exits_with_a_hint(capsys):
    assert main(["ヌプシ"]) == 2
    assert "--urls" in capsys.readouterr().err


def test_reads_from_stdin(tmp_path, capsys, monkeypatch):
    import io

    monkeypatch.setattr("sys.stdin", io.StringIO(MERCARI))
    assert main(["ヌプシ", "--mercari", "-"]) == 0
    assert "メルカリ（売り切れ）" in capsys.readouterr().out


def test_unreadable_text_exits_nonzero(tmp_path, capsys):
    path = write(tmp_path, "y.txt", "ノースフェイス ヌプシ\nパタゴニア レトロX\n")
    assert main(["ヌプシ", "--yahoo", path]) == 1
    assert "読み取れませんでした" in capsys.readouterr().out
