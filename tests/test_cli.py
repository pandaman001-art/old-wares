from oldwares.cli import main


def test_cli_prints_a_summary(capsys):
    code = main(["ノースフェイス ヌプシ", "--sources", "demo-yahoo,demo-mercari", "--no-cache"])
    out = capsys.readouterr().out
    assert code == 0
    assert "相場（両サイト中央値の平均）" in out
    assert "デモ：ヤフオク相当" in out


def test_cli_json_output_is_parseable(capsys):
    import json

    main(["ダウン", "--sources", "demo-yahoo", "--json", "--no-cache"])
    data = json.loads(capsys.readouterr().out)
    assert data["combined"]["count"] > 0
    assert data["sources"][0]["source"] == "demo-yahoo"


def test_cli_reports_no_data_with_a_nonzero_exit(capsys, monkeypatch):
    from oldwares import service
    from oldwares.models import SourceResult

    class Empty:
        key, label = "demo-yahoo", "デモ"

        def collect(self, *a, **k):
            return SourceResult(source=self.key, label=self.label)

    monkeypatch.setattr(service, "build_source", lambda *a, **k: Empty())
    assert main(["存在しない語", "--sources", "demo-yahoo", "--no-cache"]) == 1
