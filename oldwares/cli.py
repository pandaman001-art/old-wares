"""コマンドラインから相場を出す。

    # 検索結果をコピーしてファイルに保存しておき、まとめて計算する
    python -m oldwares.cli "ノースフェイス ヌプシ 700" --yahoo yahoo.txt --mercari mercari.txt

    # 標準入力から（片方だけでも動く）
    pbpaste | python -m oldwares.cli "パタゴニア レトロX" --mercari -
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .service import DEFAULT_GROUPS, InputGroup, QuoteOptions, quote, search_page_url

LABELS = dict(DEFAULT_GROUPS)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="oldwares", description="貼り付けた検索結果から中古服の相場を出す")
    parser.add_argument("query", help="調べたい服の名前")
    parser.add_argument("--yahoo", metavar="FILE", help="ヤフオクの検索結果を貼ったファイル（- で標準入力）")
    parser.add_argument("--mercari", metavar="FILE", help="メルカリの検索結果を貼ったファイル（- で標準入力）")
    parser.add_argument("--price-min", type=int, default=None)
    parser.add_argument("--price-max", type=int, default=None)
    parser.add_argument("--exclude", default="", help="カンマ区切りの除外語")
    parser.add_argument("--keep-outliers", action="store_true", help="外れ値を除去しない")
    parser.add_argument("--no-default-excludes", action="store_true", help="まとめ売り等の自動除外を使わない")
    parser.add_argument("--json", action="store_true", help="JSON で出力する")
    parser.add_argument("--urls", action="store_true", help="検索ページの URL だけ表示して終了する")
    return parser


def _read(path: str | None) -> str:
    if not path:
        return ""
    if path == "-":
        return sys.stdin.read()
    return Path(path).read_text("utf-8")


def _yen(value: int | None) -> str:
    return "—" if value is None else f"¥{value:,}"


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.urls:
        for key, label in DEFAULT_GROUPS:
            print(f"{label}: {search_page_url(key, args.query)}")
        return 0

    texts = {"yahoo": _read(args.yahoo), "mercari": _read(args.mercari)}
    if not any(text.strip() for text in texts.values()):
        print("検索結果を貼ったファイルを --yahoo / --mercari で渡してください。", file=sys.stderr)
        print("検索ページの URL は --urls で確認できます。", file=sys.stderr)
        return 2

    groups = [InputGroup(key=key, label=LABELS[key], text=texts[key]) for key, _ in DEFAULT_GROUPS if texts[key].strip()]
    options = QuoteOptions(
        price_min=args.price_min,
        price_max=args.price_max,
        exclude_words=[w.strip() for w in args.exclude.split(",") if w.strip()],
        use_default_excludes=not args.no_default_excludes,
        remove_outliers=not args.keep_outliers,
    )
    result = quote(args.query, groups, options)

    if args.json:
        json.dump(result.to_dict(), sys.stdout, ensure_ascii=False, indent=2)
        print()
        return 0

    print(f"検索語: {result.query}")
    for source in result.sources:
        if source.error:
            print(f"  [NG] {source.label}: {source.error}")
            continue
        stats = source.stats
        print(
            f"  {source.label}: 中央値 {_yen(stats.median)} / 平均 {_yen(stats.mean)}"
            f" / {stats.count} 件（読み取り {len(source.listings)}・除外 {source.excluded_count}）"
        )
    combined, blend = result.combined, result.blend
    if combined and combined.count:
        print(f"\n  相場（両サイト中央値の平均）: {_yen(blend.equal_weight_median)}")
        print(f"  よくある価格帯: {_yen(combined.p25)} 〜 {_yen(combined.p75)}")
        print(f"  全 {combined.count} 件 / 中央値 {_yen(combined.median)} / 平均 {_yen(combined.mean)}")
    for warning in result.warnings:
        print(f"  ! {warning}")
    return 0 if (combined and combined.count) else 1


if __name__ == "__main__":
    raise SystemExit(main())
