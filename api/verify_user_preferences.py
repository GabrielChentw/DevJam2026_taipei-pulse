"""Verify anonymous preference validation and local fallback without Firestore."""

import os

from app.data_sources.user_preferences import load_user_preferences, save_user_preferences
from app.models import UserPreferences, UserPreferencesSnapshot


os.environ.pop("FIRESTORE_PROJECT_ID", None)
os.environ.pop("GOOGLE_CLOUD_PROJECT", None)
user_id = "demo-user-12345678"
preferences = UserPreferences(
    accessibility_mode="wheelchair",
    profile_detail="電動輪椅",
    speech_rate=1.25,
    theme="dark",
)

saved = UserPreferencesSnapshot.model_validate(save_user_preferences(user_id, preferences))
assert saved.storage_mode == "memory"
assert saved.updated_at
assert saved.accessibility_mode == "wheelchair"

loaded = UserPreferencesSnapshot.model_validate(load_user_preferences(user_id))
assert loaded.model_dump() == saved.model_dump()
assert "location" not in loaded.model_dump()

try:
    load_user_preferences("../unsafe")
except ValueError:
    pass
else:
    raise AssertionError("unsafe user id should be rejected")

print("user preferences OK: opt-in fields saved; location/chat absent; memory fallback explicit")
