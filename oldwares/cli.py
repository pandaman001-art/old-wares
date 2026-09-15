"""コマンドラインから相場を確認する（取得元のデバッグ用）。

    python -m oldwares.cli "ノースフェイス ヌプシ 700" --sources yahoo,mercari
"""

from __future__ import annotations

import argparse
import json
import sys

from .service import SearchOptions, search
from .sources import DEFAULT_SOURCES, available_sources


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="oldwares", description="中古服の相場を調べる")
    parser.add_argument("query", help="検索語")
    parser.add_argument("--sources", default=",".join(DEFAULT_SOURCES),
                        help=f"カンマ区切り。利用可能: {', '.join(s['key'] for s in available_sources())}")
    parser.add_argument("--limit", type=int, default=120, help="取得元ごとの最大件数")
    parser.add_argument("--price-min", type=int, default=None)
    parser.add_argument("--price-max", type=int, default=None)
    parser.add_argument("--exclude", default="", help="カンマ区切りの除外語")
    parser.add_argument("--keep-outliers", action="store_true", help="外れ値を除去しない")
    parser.add_argument("--no-cache", action="store_true", help="キャッシュを使わない")
    parser.add_argument("--json", action="store_true", help="JSON で出力する")
    return parser


def _yen(value: int | None) -> str:
    return "—" if value is None else f"¥{value:,}"


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    options = SearchOptions(
        sources=tuple(s.strip() for s in args.sources.split(",") if s.strip()),
        limit=args.limit,
        price_min=args.price_min,
        price_max=args.price_max,
        exclude_words=[w.strip() for w in args.exclude.split(",") if w.strip()],
        remove_outliers=not args.keep_outliers,
        cache_ttl=0 if args.no_cache else 30 * 60,
    )
    result = search(args.query, options)

    if args.json:
        json.dump(result.to_dict(), sys.stdout, ensure_ascii=False, indent=2)
        print()
        return 0

    print(f"検索語: {result.query}")
    for source in result.sources:
        if not source.ok:
            print(f"  [NG] {source.label}: {source.error}")
            continue
        stats = source.stats
        print(
            f"  {source.label}: 中央値 {_yen(stats.median)} / 平均 {_yen(stats.mean)}"
            f" / {stats.count} 件（取得 {len(source.listings)}・除外 {source.excluded_count}）"
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
