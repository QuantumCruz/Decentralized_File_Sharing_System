"""Unit tests for the Python and Electron development configuration bridges."""

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.prepare_dev_profile import prepare
from server.dev_runtime import (
    load_development_runtime,
    DevelopmentConfigurationError,
    PORTS,
)


class DevelopmentRuntimeTests(unittest.TestCase):

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

        self.root = Path(
            self.temp.name
        ).resolve()

        (self.root / "server").mkdir()

        (self.root / "package.json").write_text(
            "{}",
            encoding="utf-8",
        )

        (
            self.root
            / "server"
            / "server_persistent.py"
        ).write_text(
            "",
            encoding="utf-8",
        )

        self.manifest = prepare(self.root)

    def test_runtime_uses_only_development_paths(self):
        runtime = load_development_runtime(
            self.root
        )

        self.assertEqual(
            runtime.ports,
            PORTS,
        )

        self.assertEqual(
            runtime.owner_url,
            "http://127.0.0.1:15300",
        )

        self.assertEqual(
            runtime.public_url,
            "http://127.0.0.1:15302",
        )

        self.assertTrue(
            runtime.database.is_relative_to(
                runtime.workspace
            )
        )

        self.assertFalse(
            runtime.database.exists()
        )

    def test_runtime_environment_does_not_inherit_production_settings(
        self
    ):
        runtime = load_development_runtime(
            self.root
        )

        env = runtime.subprocess_environment({
            "CLEARNET_URL": "https://example.invalid",
            "PATH": "test",
        })

        self.assertNotIn(
            "CLEARNET_URL",
            env,
        )

        self.assertEqual(
            env["IPFS_PATH"],
            str(runtime.ipfs_repo),
        )

        self.assertEqual(
            env["FILESHARE_DB_PATH"],
            str(runtime.database),
        )

        self.assertEqual(
            env["FILESHARE_PUBLIC_PORT"],
            "15302",
        )

        self.assertEqual(
            env["FILESHARE_MODE"],
            "development",
        )

        self.assertGreaterEqual(
            len(env["FILESHARE_ADMIN_TOKEN"]),
            32,
        )

    def test_each_session_gets_a_distinct_secret(self):
        runtime = load_development_runtime(
            self.root
        )

        self.assertNotEqual(
            runtime.subprocess_environment({})[
                "FILESHARE_ADMIN_TOKEN"
            ],
            runtime.subprocess_environment({})[
                "FILESHARE_ADMIN_TOKEN"
            ],
        )

    def test_rejects_tampered_database_path(self):
        payload = json.loads(
            self.manifest.read_text(
                encoding="utf-8"
            )
        )

        payload["paths"]["database"] = str(
            self.root
            / "server"
            / "metadata.db"
        )

        self.manifest.write_text(
            json.dumps(payload),
            encoding="utf-8",
        )

        with self.assertRaises(
            DevelopmentConfigurationError
        ):
            load_development_runtime(
                self.root
            )

    def test_rejects_tampered_ports(self):
        payload = json.loads(
            self.manifest.read_text(
                encoding="utf-8"
            )
        )

        payload["ports"]["ipfs_api"] = 5001

        self.manifest.write_text(
            json.dumps(payload),
            encoding="utf-8",
        )

        with self.assertRaises(
            DevelopmentConfigurationError
        ):
            load_development_runtime(
                self.root
            )

    def test_rejects_modified_tor_configuration(self):
        runtime = load_development_runtime(
            self.root
        )

        runtime.torrc.write_text(
            "ControlPort 9051\n",
            encoding="utf-8",
        )

        with self.assertRaises(
            DevelopmentConfigurationError
        ):
            load_development_runtime(
                self.root
            )

    @unittest.skipUnless(
        shutil.which("node"),
        "Node.js is not installed",
    )
    def test_electron_bridge_reads_the_same_profile(self):
        script = (
            ROOT
            / "public"
            / "dev_runtime.js"
        )

        result = subprocess.run(
            [
                "node",
                str(script),
                str(self.root),
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )

        self.assertEqual(
            result.returncode,
            0,
            result.stderr,
        )

        self.assertIn(
            "Owner: http://127.0.0.1:15300",
            result.stdout,
        )

        self.assertIn(
            "Public: http://127.0.0.1:15302",
            result.stdout,
        )


if __name__ == "__main__":
    unittest.main()