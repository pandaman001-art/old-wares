#!/usr/bin/env bash
# 開発用の起動スクリプト。初回は venv を作って依存を入れる。
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip >/dev/null
  .venv/bin/pip install -r requirements.txt
fi

exec .venv/bin/uvicorn oldwares.api:app --reload --host "${HOST:-127.0.0.1}" --port "${PORT:-8000}"
