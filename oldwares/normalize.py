"""検索語の正規化と、相場から外すべき出品の判定。

中古服の実売データは「まとめ売り」「ジャンク」「レプリカ」などが混ざると
中央値が簡単に歪むので、統計に入れる前に落とす。
"""

from __future__ import annotations

import re
import unicodedata

from .models import Listing

# 既定の除外キーワード。理由つきで持っておき、UI に「なぜ落としたか」を出す。
DEFAULT_EXCLUDE_RULES: tuple[tuple[str, str], ...] = (
    (r"まとめ売り|まとめて|おまとめ|大量|詰め合わせ|福袋", "まとめ売り"),
    # 「セットアップ」は上下セットの正規商品なので除外しない
    (r"(?<!アップ)セット(?!アップ)", "セット売り"),
    # 「汚れあり」「破れ」単体は出品状態の記載としてよく使われ、正常な出品まで
    # 落としてしまうので入れない
    (r"ジャンク|訳あり|わけあり|難あり|要修理|補修前提", "難あり"),
    (r"レプリカ|コピー品|複製|偽物|疑い", "レプリカ/真贋"),
    (r"キッズ|子供服|こども服|ベビー|ペット用|犬用|猫用", "対象違い"),
    (r"型紙|生地のみ|カタログ|雑誌|写真集|ポスター|チラシ|DVD", "商品違い"),
    (r"ハンガーのみ|タグのみ|袋のみ|空箱|付属品のみ|パーツのみ", "本体でない"),
)

_COMPILED_DEFAULT = tuple((re.compile(p), reason) for p, reason in DEFAULT_EXCLUDE_RULES)

# 中古服として現実的な価格帯の既定ガード
DEFAULT_MIN_PRICE = 300
DEFAULT_MAX_PRICE = 3_000_000


def normalize_text(text: str) -> str:
    """全角英数・カナを正規化し、空白を詰める。比較・照合用。"""
    normalized = unicodedata.normalize("NFKC", text or "")
    return re.sub(r"\s+", " ", normalized).strip()


def normalize_query(query: str) -> str:
    """検索語の正規化。空白の揺れを吸収するだけで、語の削除はしない。"""
    return normalize_text(query)


def compile_extra_excludes(words: list[str] | None) -> tuple[tuple[re.Pattern[str], str], ...]:
    """ユーザー指定の除外語をコンパイルする。正規表現ではなく素の文字列として扱う。"""
    rules = []
    for word in words or []:
        word = normalize_text(word)
        if word:
            rules.append((re.compile(re.escape(word), re.IGNORECASE), f"除外語: {word}"))
    return tuple(rules)


def default_rules_for_query(query: str) -> tuple[tuple[re.Pattern[str], str], ...]:
    """検索語自体に当たる既定ルールは無効化する。

    「キッズ ダウン」を探しているのに「キッズ」で全部落とす、といった事故を防ぐ。
    """
    normalized = normalize_text(query)
    return tuple(
        (pattern, reason)
        for pattern, reason in _COMPILED_DEFAULT
        if not pattern.search(normalized)
    )


def exclusion_reason(
    listing: Listing,
    *,
    extra_rules: tuple[tuple[re.Pattern[str], str], ...] = (),
    default_rules: tuple[tuple[re.Pattern[str], str], ...] | None = None,
    min_price: int = DEFAULT_MIN_PRICE,
    max_price: int = DEFAULT_MAX_PRICE,
) -> str | None:
    """統計から外す理由。外す必要がなければ None。"""
    if listing.price < min_price:
        return f"下限価格({min_price:,}円)未満"
    if listing.price > max_price:
        return f"上限価格({max_price:,}円)超"

    title = normalize_text(listing.title)
    rules = (_COMPILED_DEFAULT if default_rules is None else default_rules) + extra_rules
    for pattern, reason in rules:
        if pattern.search(title):
            return reason
    return None


def apply_filters(
    listings: list[Listing],
    *,
    query: str = "",
    exclude_words: list[str] | None = None,
    use_defaults: bool = True,
    min_price: int = DEFAULT_MIN_PRICE,
    max_price: int = DEFAULT_MAX_PRICE,
) -> list[Listing]:
    """listing に excluded / exclude_reason を書き込んで返す（破壊的）。"""
    extra = compile_extra_excludes(exclude_words)
    defaults = default_rules_for_query(query) if use_defaults else ()
    for listing in listings:
        reason = exclusion_reason(
            listing,
            extra_rules=extra,
            default_rules=defaults,
            min_price=min_price,
            max_price=max_price,
        )
        listing.excluded = reason is not None
        listing.exclude_reason = reason
    return listings


def dedupe(listings: list[Listing]) -> list[Listing]:
    """同じ取得元で同一 item_id が重複した場合に 1 件へ畳む。"""
    seen: set[tuple[str, str]] = set()
    out: list[Listing] = []
    for listing in listings:
        key = (listing.source, listing.item_id)
        if key in seen:
            continue
        seen.add(key)
        out.append(listing)
    return out
