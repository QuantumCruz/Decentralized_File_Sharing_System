"""Guard tests for isolated Python development startup."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest

from pathlib import Path
from unittest.mock import patch


PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from scripts.prepare_dev_profile import prepare
from server.dev_runtime import load_development_runtime
from server.dev_server import validate_environment


ONION = "a" * 56


class DevelopmentStartupTests(unittest.TestCase):

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)

        root = Path(temp.name)

        (root / "server").mkdir()

        (root / "package.json").write_text(
            "{}",
            encoding="utf-8",
        )

        (
            root
            / "server"
            / "server_persistent.py"
        ).write_text(
            "",
            encoding="utf-8",
        )

        prepare(root)

        self.runtime = load_development_runtime(root)

        self.env = self.runtime.subprocess_environment({})

        self.env["FILESHARE_ONION_HOST"] = ONION

        self.env["CLEARNET_URL"] = (
            "https://stage1-test.trycloudflare.com"
        )

    def test_valid_dev_environment(self):
        with patch.dict(
            os.environ,
            self.env,
            clear=True,
        ):
            token, onion, cloudflare = (
                validate_environment(self.runtime)
            )

        self.assertEqual(
            token,
            self.env["FILESHARE_ADMIN_TOKEN"],
        )

        self.assertEqual(
            onion,
            ONION,
        )

        self.assertEqual(
            cloudflare,
            "https://stage1-test.trycloudflare.com",
        )

    def test_missing_token_refused(self):
        env = {
            **self.env,
            "FILESHARE_ADMIN_TOKEN": "",
        }

        with patch.dict(
            os.environ,
            env,
            clear=True,
        ):
            with self.assertRaises(RuntimeError):
                validate_environment(self.runtime)

    def test_production_ipfs_path_refused(self):
        env = {
            **self.env,
            "IPFS_PATH": str(
                Path.home() / ".ipfs"
            ),
        }

        with patch.dict(
            os.environ,
            env,
            clear=True,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "IPFS_PATH",
            ):
                validate_environment(self.runtime)

    def test_production_port_refused(self):
        env = {
            **self.env,
            "FILESHARE_OWNER_PORT": "5000",
        }

        with patch.dict(
            os.environ,
            env,
            clear=True,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "FILESHARE_OWNER_PORT",
            ):
                validate_environment(self.runtime)

    def test_invalid_onion_refused(self):
        env = {
            **self.env,
            "FILESHARE_ONION_HOST": "production.onion",
        }

        with patch.dict(
            os.environ,
            env,
            clear=True,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "Onion",
            ):
                validate_environment(self.runtime)

    def test_unexpected_tunnel_refused(self):
        env = {
            **self.env,
            "CLEARNET_URL": "http://localhost:5000",
        }

        with patch.dict(
            os.environ,
            env,
            clear=True,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "Cloudflare",
            ):
                validate_environment(self.runtime)


if __name__ == "__main__":
    unittest.main()