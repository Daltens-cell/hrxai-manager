"""설정 저장/불러오기.

웹 앱 URL과 토큰은 exe 안에 넣지 않고, 처음 실행 때 입력받아
내 PC 사용자 폴더에만 저장함 (Windows: %APPDATA%\\HRxAI-Manager\\config.json).
"""
import json
import os
from pathlib import Path

APP_NAME = "HRxAI-Manager"


def config_dir() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home() / ".config")
    d = Path(base) / APP_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def config_path() -> Path:
    return config_dir() / "config.json"


DEFAULTS = {"url": "", "token": "", "demo": True}


def load() -> dict:
    try:
        data = json.loads(config_path().read_text(encoding="utf-8"))
        return {**DEFAULTS, **data}
    except (OSError, ValueError):
        return dict(DEFAULTS)


def save(cfg: dict) -> None:
    config_path().write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
