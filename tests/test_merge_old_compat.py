from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.api.v1.admin import token as token_api
from app.core.config import Config
from app.core.storage import LocalStorage


class ConfigCompatTests(unittest.IsolatedAsyncioTestCase):
    async def test_ensure_loaded_only_runs_once_after_success(self) -> None:
        cfg = Config()
        calls = 0

        async def fake_load() -> None:
            nonlocal calls
            calls += 1
            cfg._loaded = True

        cfg.load = fake_load  # type: ignore[method-assign]

        await cfg.ensure_loaded()
        await cfg.ensure_loaded()

        self.assertEqual(calls, 1)


class TokenApiCompatTests(unittest.IsolatedAsyncioTestCase):
    async def test_get_tokens_returns_tokens_and_consumed_mode_flag(self) -> None:
        fake_pool = type(
            "FakePool",
            (),
            {
                "list": lambda self: [
                    type(
                        "FakeToken",
                        (),
                        {
                            "model_dump": lambda self: {
                                "token": "sso=test-token",
                                "quota": 80,
                                "consumed": 3,
                                "status": "active",
                            }
                        },
                    )()
                ]
            },
        )()
        fake_manager = type("FakeManager", (), {"pools": {"ssoBasic": fake_pool}})()

        with patch.object(token_api, "get_token_manager", AsyncMock(return_value=fake_manager)):
            with patch("app.core.config.get_config", return_value=True):
                payload = await token_api.get_tokens()

        self.assertIn("tokens", payload)
        self.assertEqual(payload["consumed_mode_enabled"], True)
        self.assertEqual(payload["tokens"]["ssoBasic"][0]["consumed"], 3)


class LocalStorageCompatTests(unittest.IsolatedAsyncioTestCase):
    async def test_save_tokens_skips_empty_payload_when_existing_tokens_present(self) -> None:
        storage = LocalStorage()
        with tempfile.TemporaryDirectory() as temp_dir:
            token_file = Path(temp_dir) / "token.json"
            token_file.write_text(
                json.dumps({"ssoBasic": [{"token": "sso=keep-me", "quota": 80}]}),
                encoding="utf-8",
                newline="\r\n",
            )

            with patch("app.core.storage.TOKEN_FILE", token_file):
                await storage.save_tokens({})
                saved = json.loads(token_file.read_text(encoding="utf-8"))

        self.assertEqual(saved["ssoBasic"][0]["token"], "sso=keep-me")


if __name__ == "__main__":
    unittest.main()
