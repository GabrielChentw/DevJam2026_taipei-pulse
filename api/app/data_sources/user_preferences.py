"""Anonymous user preferences backed by Google Cloud Firestore.

The client opts in before writing. Only accessibility presentation settings
are stored; precise location, trip history and chat transcripts are excluded.
When Firestore is not configured, an in-process store keeps local development
testable without pretending that the data is durable.
"""

from __future__ import annotations

import os
import re
import threading
from datetime import datetime, timezone
from typing import Any

from ..models import UserPreferences


_USER_ID = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
_lock = threading.Lock()
_memory: dict[str, dict[str, Any]] = {}


def _validate_user_id(user_id: str) -> str:
    if not _USER_ID.fullmatch(user_id):
        raise ValueError("user_id 必須是 8–128 字元的匿名英數識別碼")
    return user_id


def _project_id() -> str | None:
    return os.getenv("FIRESTORE_PROJECT_ID") or os.getenv("GOOGLE_CLOUD_PROJECT")


def _document(user_id: str):
    from google.cloud import firestore

    database = os.getenv("FIRESTORE_DATABASE", "(default)")
    client = firestore.Client(project=_project_id(), database=database)
    return client.collection("users").document(user_id).collection("settings").document("preferences")


def _default(user_id: str, mode: str, notices: list[str] | None = None) -> dict[str, Any]:
    return {
        "user_id": user_id,
        **UserPreferences().model_dump(),
        "updated_at": None,
        "storage_mode": mode,
        "notices": notices or [],
    }


def load_user_preferences(user_id: str) -> dict[str, Any]:
    user_id = _validate_user_id(user_id)
    project = _project_id()
    if project:
        try:
            snapshot = _document(user_id).get()
            if snapshot.exists:
                data = snapshot.to_dict() or {}
                return {
                    "user_id": user_id,
                    **UserPreferences.model_validate(data).model_dump(),
                    "updated_at": data.get("updated_at"),
                    "storage_mode": "firestore",
                    "notices": [],
                }
            return _default(user_id, "firestore")
        except Exception:
            notice = "Firestore 暫時不可用，本次使用伺服器記憶體回退；服務重啟後不保留。"
            with _lock:
                data = _memory.get(user_id)
            return {**_default(user_id, "memory_fallback", [notice]), **(data or {})}

    with _lock:
        data = _memory.get(user_id)
    return {**_default(user_id, "memory", ["未設定 FIRESTORE_PROJECT_ID，偏好只保留到服務重啟。"]), **(data or {})}


def save_user_preferences(user_id: str, preferences: UserPreferences) -> dict[str, Any]:
    user_id = _validate_user_id(user_id)
    updated_at = datetime.now(timezone.utc).isoformat()
    data = {**preferences.model_dump(), "updated_at": updated_at}
    project = _project_id()
    if project:
        try:
            _document(user_id).set(data, merge=True)
            return {
                "user_id": user_id,
                **preferences.model_dump(),
                "updated_at": updated_at,
                "storage_mode": "firestore",
                "notices": [],
            }
        except Exception:
            with _lock:
                _memory[user_id] = data
            return {
                "user_id": user_id,
                **preferences.model_dump(),
                "updated_at": updated_at,
                "storage_mode": "memory_fallback",
                "notices": ["Firestore 寫入失敗，本次暫存於伺服器記憶體；服務重啟後不保留。"],
            }

    with _lock:
        _memory[user_id] = data
    return {
        "user_id": user_id,
        **preferences.model_dump(),
        "updated_at": updated_at,
        "storage_mode": "memory",
        "notices": ["未設定 FIRESTORE_PROJECT_ID，偏好只保留到服務重啟。"],
    }
