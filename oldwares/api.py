"""FastAPI アプリ本体。UI と JSON API を提供する。

外部サイトへのアクセスは一切しない。価格は利用者が貼り付けたテキストから読む。
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import __version__
from .service import (
    DEFAULT_GROUPS,
    InputGroup,
    QuoteOptions,
    quote,
    search_page_url,
)
from .store import RecordStore

STATIC_DIR = Path(__file__).parent / "static"
MAX_TEXT_LENGTH = 400_000

app = FastAPI(
    title="old-wares",
    description="ヤフオクとメルカリの検索結果を貼り付けて中古服の相場を出す",
    version=__version__,
)


# --- リクエストの形 ------------------------------------------------------
class GroupIn(BaseModel):
    key: str = Field(..., min_length=1, max_length=40)
    label: str = Field("", max_length=80)
    text: str = Field("", max_length=MAX_TEXT_LENGTH)


class OptionsIn(BaseModel):
    price_min: int | None = Field(None, ge=0)
    price_max: int | None = Field(None, ge=0)
    exclude_words: list[str] = Field(default_factory=list)
    use_default_excludes: bool = True
    remove_outliers: bool = True


class QuoteIn(BaseModel):
    query: str = Field("", max_length=200)
    groups: list[GroupIn] = Field(default_factory=list)
    options: OptionsIn = Field(default_factory=OptionsIn)


class RecordIn(BaseModel):
    query: str = Field("", max_length=200)
    groups: list[GroupIn] = Field(default_factory=list)
    summary: dict = Field(default_factory=dict)
    note: str = Field("", max_length=500)


DEFAULT_LABELS = dict(DEFAULT_GROUPS)


def _to_options(payload: OptionsIn) -> QuoteOptions:
    if payload.price_min is not None and payload.price_max is not None:
        if payload.price_min > payload.price_max:
            raise HTTPException(status_code=400, detail="下限価格が上限価格を超えています")
    return QuoteOptions(
        price_min=payload.price_min,
        price_max=payload.price_max,
        exclude_words=[w.strip() for w in payload.exclude_words if w.strip()],
        use_default_excludes=payload.use_default_excludes,
        remove_outliers=payload.remove_outliers,
    )


# --- 画面 ----------------------------------------------------------------
@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "version": __version__}


@app.get("/api/groups")
def groups(q: str = Query("", max_length=200)) -> dict:
    """既定の入力グループと、利用者が自分で開くための検索ページ URL。"""
    return {
        "groups": [
            {"key": key, "label": label, "search_url": search_page_url(key, q) if q else ""}
            for key, label in DEFAULT_GROUPS
        ]
    }


@app.post("/api/quote")
def api_quote(payload: QuoteIn) -> dict:
    if not payload.groups:
        raise HTTPException(status_code=400, detail="入力グループがありません")
    options = _to_options(payload.options)
    groups = [
        InputGroup(key=g.key, label=g.label or DEFAULT_LABELS.get(g.key, g.key), text=g.text)
        for g in payload.groups
    ]
    return quote(payload.query, groups, options).to_dict()


# --- 保存した調査 --------------------------------------------------------
@app.get("/api/records")
def list_records(limit: int = Query(50, ge=1, le=200)) -> dict:
    return {"records": RecordStore().list(limit=limit)}


@app.post("/api/records", status_code=201)
def create_record(payload: RecordIn) -> dict:
    record = RecordStore().save(
        query=payload.query,
        groups=[g.model_dump() for g in payload.groups],
        summary=payload.summary,
        note=payload.note,
    )
    return record.to_dict()


@app.get("/api/records/{record_id}")
def get_record(record_id: str) -> dict:
    record = RecordStore().get(record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="見つかりません")
    return record.to_dict()


@app.delete("/api/records/{record_id}")
def delete_record(record_id: str) -> dict:
    if not RecordStore().delete(record_id):
        raise HTTPException(status_code=404, detail="見つかりません")
    return {"deleted": record_id}
