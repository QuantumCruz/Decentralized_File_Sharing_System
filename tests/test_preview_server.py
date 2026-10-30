"""Preview runtime refuses production and development paths/ports."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from server.preview_server import load_settings


class PreviewRuntimeTests(unittest.TestCase):

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)

        local = Path(temp.name).resolve(
            strict=True
        )

        root = local / "FileSharePreviewRC"

        build = (
            local
            / "resources"
            / "server"
            / "build"
        )

        build.mkdir(
            parents=True
        )

        (build / "index.html").write_text(
            "ok",
            encoding="utf-8",
        )

        self.env = {
            "LOCALAPPDATA": str(local),
            "FILESHARE_MODE": "preview",
            "FILESHARE_PREVIEW_ROOT": str(root),
            "FILESHARE_DB_PATH": str(
                root / "state" / "metadata.db"
            ),
            "FILESHARE_TEMP_DIR": str(
                root / "temporary"
            ),
            "IPFS_PATH": str(
                root / "ipfs"
            ),
            "FILESHARE_IPFS_API": (
                "http://127.0.0.1:25301/api/v0"
            ),
            "FILESHARE_OWNER_HOST": "127.0.0.1",
            "FILESHARE_PUBLIC_HOST": "127.0.0.1",
            "FILESHARE_OWNER_PORT": "25300",
            "FILESHARE_PUBLIC_PORT": "25302",
            "FILESHARE_TOR_CONTROL_PORT": "29351",
            "FILESHARE_BUILD_DIR": str(build),
            "FILESHARE_ADMIN_TOKEN": "q" * 64,
            "FILESHARE_ONION_HOST": "a" * 56,
            "CLEARNET_URL": (
                "https://preview-test.trycloudflare.com"
            ),
        }

    def test_accepts_private_preview_configuration(self):
        settings = load_settings(
            self.env
        )

        self.assertEqual(
            settings.root.name,
            "FileSharePreviewRC",
        )

        self.assertEqual(
            settings.clearnet,
            self.env["CLEARNET_URL"],
        )

    def test_refuses_original_application_database(self):
        env = {
            **self.env,
            "FILESHARE_DB_PATH": str(
                Path.home()
                / "AppData"
                / "Local"
                / "FileShare"
                / "metadata.db"
            ),
        }

        with self.assertRaisesRegex(
            RuntimeError,
            "FILESHARE_DB_PATH",
        ):
            load_settings(env)

    def test_refuses_development_port(self):
        env = {
            **self.env,
            "FILESHARE_OWNER_PORT": "15300",
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
            "token",
        ):
            load_settings(env)

    def test_refuses_unexpected_public_url(self):
        env = {
            **self.env,
            "CLEARNET_URL": (
                "http://localhost:5000"
            ),
        }

        with self.assertRaisesRegex(
            RuntimeError,
            "Cloudflare",
        ):
            load_settings(env)

    def test_refuses_missing_frontend(self):
        env = {
            **self.env,
            "FILESHARE_BUILD_DIR": str(
                Path.home()
                / "does-not-exist"
            ),
        }

        with self.assertRaisesRegex(
            RuntimeError,
            "frontend",
        ):
            load_settings(env)


if __name__ == "__main__":
    unittest.main()