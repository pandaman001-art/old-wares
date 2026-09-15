"""FastAPI アプリ本体。UI と JSON/CSV API を提供する。"""

from __future__ import annotations

import csv
import io
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from . import __version__
from .cache import Cache
from .service import MAX_LIMIT, SearchOptions, search
from .sources import DEFAULT_SOURCES, available_sources

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(
    title="old-wares",
    description="ヤフオクとメルカリの実売価格から中古服の相場を出す",
    version=__version__,
)


def _split_csv(value: str | None) -> list[str]:
    return [part.strip() for part in (value or "").split(",") if part.strip()]


def _build_options(
    sources: str | None,
    limit: int,
    price_min: int | None,
    price_max: int | None,
    exclude: str | None,
    default_excludes: bool,
    remove_outliers: bool,
    fresh: bool,
) -> SearchOptions:
    keys = tuple(_split_csv(sources)) or DEFAULT_SOURCES
    known = {s["key"] for s in available_sources()}
    unknown = [k for k in keys if k not in known]
    if unknown:
        raise HTTPException(status_code=400, detail=f"未知の取得元: {', '.join(unknown)}")
    if price_min is not None and price_max is not None and price_min > price_max:
        raise HTTPException(status_code=400, detail="price_min が price_max を超えています")
    return SearchOptions(
        sources=keys,
        limit=limit,
        price_min=price_min,
        price_max=price_max,
        exclude_words=_split_csv(exclude),
        use_default_excludes=default_excludes,
        remove_outliers=remove_outliers,
        cache_ttl=0 if fresh else int(os.environ.get("OLDWARES_CACHE_TTL", 1800)),
    )


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "version": __version__}


@app.get("/api/sources")
def sources() -> dict:
    return {"sources": available_sources(), "default": list(DEFAULT_SOURCES)}


@app.get("/api/search")
def api_search(
    q: str = Query(..., min_length=1, description="検索語（例: ノースフェイス ヌプシ 700）"),
    sources: str | None = Query(None, description="カンマ区切り。既定は yahoo,mercari"),
    limit: int = Query(120, ge=1, le=MAX_LIMIT, description="取得元ごとの最大取得件数"),
    price_min: int | None = Query(None, ge=0),
    price_max: int | None = Query(None, ge=0),
    exclude: str | None = Query(None, description="カンマ区切りの除外語"),
    default_excludes: bool = Query(True, description="まとめ売り等の既定除外を使う"),
    remove_outliers: bool = Query(True, description="IQR で外れ値を除く"),
    fresh: bool = Query(False, description="キャッシュを使わず取得し直す"),
) -> JSONResponse:
    options = _build_options(
        sources, limit, price_min, price_max, exclude, default_excludes, remove_outliers, fresh
    )
    result = search(q, options)
    return JSONResponse(result.to_dict())


@app.get("/api/export.csv")
def export_csv(
    q: str = Query(..., min_length=1),
    sources: str | None = Query(None),
    limit: int = Query(120, ge=1, le=MAX_LIMIT),
    price_min: int | None = Query(None, ge=0),
    price_max: int | None = Query(None, ge=0),
    exclude: str | None = Query(None),
    default_excludes: bool = Query(True),
    remove_outliers: bool = Query(True),
    include_excluded: bool = Query(False, description="除外された出品も出力する"),
) -> StreamingResponse:
    options = _build_options(
        sources, limit, price_min, price_max, exclude, default_excludes, remove_outliers, True
    )
    result = search(q, options)

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["取得元", "タイトル", "価格", "売却日", "状態", "URL", "統計に使用", "除外理由"])
    for source_result in result.sources:
        for listing in source_result.listings:
            if listing.excluded and not include_excluded:
                continue
            writer.writerow(
                [
                    source_result.label,
                    listing.title,
                    listing.price,
                    listing.sold_at.isoformat() if listing.sold_at else "",
                    listing.condition or "",
                    listing.url,
                    "no" if listing.excluded else "yes",
                    listing.exclude_reason or "",
                ]
            )
    # Excel で文字化けしないよう BOM 付き UTF-8 で返す
    payload = "﻿" + buffer.getvalue()
    filename = "oldwares.csv"
    return StreamingResponse(
        iter([payload]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/cache/clear")
def clear_cache() -> dict:
    return {"removed": Cache().clear()}
