"""Test isolated FileShare stable runtime configuration."""

from __future__ import annotations

import tempfile
import unittest

from pathlib import Path

from server.stable_server import load_settings


class StableSettingsTests(unittest.TestCase):

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)

        local = Path(
            temporary.name
        ).resolve(strict=True)

        root = (
            local
            / "QuantumCruz"
            / "FileShare"
        )

        frontend = (
            local
            / "resources"
            / "server"
            / "build"
        )

        frontend.mkdir(
            parents=True
        )

        (frontend / "index.html").write_text(
            "ok",
            encoding="utf-8",
        )

        self.env = {
            "LOCALAPPDATA": str(local),
            "FILESHARE_MODE": "stable",
            "FILESHARE_DATA_ROOT": str(root),
            "FILESHARE_DB_PATH": str(
                root / "state" / "metadata.db"
            ),
            "FILESHARE_TEMP_DIR": str(
                root / "temporary"
            ),
            "FILESHARE_BUILD_DIR": str(frontend),
            "FILESHARE_IPFS_API": (
                "http://127.0.0.1:35301/api/v0"
            ),
            "FILESHARE_OWNER_HOST": "127.0.0.1",
            "FILESHARE_PUBLIC_HOST": "127.0.0.1",
            "FILESHARE_OWNER_PORT": "35300",
            "FILESHARE_PUBLIC_PORT": "35302",
            "FILESHARE_TOR_CONTROL_PORT": "39351",
            "FILESHARE_ADMIN_TOKEN": "z" * 64,
            "FILESHARE_ONION_HOST": "a" * 56,
            "IPFS_PATH": str(root / "ipfs"),
            "CLEARNET_URL": (
                "https://example.trycloudflare.com"
            ),
        }

    def test_uses_dedicated_stable_profile(self):
        settings = load_settings(self.env)

        self.assertEqual(
            settings.root.parts[-2:],
            ("QuantumCruz", "FileShare"),
        )

        self.assertEqual(
            settings.database.parent,
            settings.root / "state",
        )

    def test_refuses_preview_profile(self):
        env = {
            **self.env,
            "FILESHARE_MODE": "preview",
        }

        with self.assertRaisesRegex(
            RuntimeError,
            "FILESHARE_MODE",
        ):
            load_settings(env)

    def test_refuses_old_database(self):
        env = {
            **self.env,
            "FILESHARE_DB_PATH": "C:/old/fileshare.db",
        }

        with self.assertRaisesRegex(
            RuntimeError,
            "FILESHARE_DB_PATH",
        ):
            load_settings(env)

    def test_refuses_preview_port(self):
        env = {
            **self.env,
            "FILESHARE_OWNER_PORT": "25300",
        }

        with self.assertRaisesRegex(
            RuntimeError,
            "FILESHARE_OWNER_PORT",
        ):
            load_settings(env)

    def test_refuses_missing_token(self):
        env = {
            **self.env,
            "FILESHARE_ADMIN_TOKEN": "",
        }

        with self.assertRaisesRegex(
            RuntimeError,
            "authentication",
        ):
            load_settings(env)

    def test_refuses_untrusted_https(self):
        env = {
            **self.env,
            "CLEARNET_URL": "http://localhost:5000",
        }

        with self.assertRaisesRegex(
            RuntimeError,
            "HTTPS tunnel",
        ):
            load_settings(env)

    def test_refuses_missing_frontend(self):
        env = {
            **self.env,
            "FILESHARE_BUILD_DIR": "C:/missing-frontend",
        }

        with self.assertRaisesRegex(
            RuntimeError,
            "frontend",
        ):
            load_settings(env)


if __name__ == "__main__":
    unittest.main()