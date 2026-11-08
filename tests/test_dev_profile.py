"""Tests for FileShare development profile isolation."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest

from pathlib import Path


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "prepare_dev_profile.py"
)

SPEC = importlib.util.spec_from_file_location(
    "prepare_dev_profile",
    SCRIPT,
)

if SPEC is None or SPEC.loader is None:
    raise RuntimeError(
        f"Unable to load {SCRIPT}"
    )

profile_tool = importlib.util.module_from_spec(
    SPEC
)

SPEC.loader.exec_module(profile_tool)


class DevProfileTests(unittest.TestCase):

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

        self.root = Path(self.temp.name).resolve()

        (self.root / "server").mkdir()

        (self.root / "package.json").write_text(
            "{}",
            encoding="utf-8",
        )

        (
            self.root / "server" / "server_persistent.py"
        ).write_text(
            "",
            encoding="utf-8",
        )

    def test_preparation_uses_only_isolated_workspace(self):
        manifest = profile_tool.prepare(
            self.root
        )

        profile = json.loads(
            manifest.read_text(encoding="utf-8")
        )

        self.assertEqual(
            profile["profile"],
            "development",
        )

        self.assertEqual(
            profile["ports"],
            profile_tool.PORTS,
        )

        self.assertTrue(
            profile_tool.verify(
                self.root,
                check_ports=False,
            )
        )

        workspace = (
            self.root / ".fileshare-dev"
        )

        for name, entry in profile["paths"].items():
            actual = Path(entry).resolve()
            expected = workspace.resolve()

            self.assertTrue(
                actual.is_relative_to(expected),
                msg=(
                    f"Path '{name}' is outside the workspace.\n"
                    f"Actual: {actual}\n"
                    f"Workspace: {expected}\n"
                    f"Original entry: {entry}"
                ),
            )

        self.assertFalse(
            (
                self.root
                / "server"
                / "metadata.db"
            ).exists()
        )

        self.assertFalse(
            (
                self.root / "binaries"
            ).exists()
        )

    def test_preparation_is_idempotent_without_deleting_data(self):
        profile_tool.prepare(self.root)

        runtime = (
            self.root / ".fileshare-dev"
        )

        sample = (
            runtime
            / "state"
            / "preserve-me.txt"
        )

        sample.write_text(
            "important",
            encoding="utf-8",
        )

        first = (
            runtime / "runtime.json"
        ).read_bytes()

        profile_tool.prepare(self.root)

        self.assertEqual(
            (
                runtime / "runtime.json"
            ).read_bytes(),
            first,
        )

        self.assertEqual(
            sample.read_text(
                encoding="utf-8"
            ),
            "important",
        )

    def test_production_ports_never_overlap(self):
        self.assertEqual(
            set(profile_tool.PORTS.values())
            & profile_tool.RESERVED_PRODUCTION_PORTS,
            set(),
        )

        self.assertEqual(
            len(profile_tool.PORTS),
            len(set(profile_tool.PORTS.values())),
        )

    def test_tampered_profile_is_rejected(self):
        manifest = profile_tool.prepare(
            self.root
        )

        profile = json.loads(
            manifest.read_text(
                encoding="utf-8"
            )
        )

        profile["paths"]["database"] = str(
            self.root
            / "server"
            / "metadata.db"
        )

        manifest.write_text(
            json.dumps(profile),
            encoding="utf-8",
        )

        with self.assertRaises(
            profile_tool.ProfileError
        ):
            profile_tool.verify(
                self.root,
                check_ports=False,
            )

    def test_existing_tor_configuration_not_overwritten(self):
        profile_tool.prepare(
            self.root
        )

        torrc = (
            self.root
            / ".fileshare-dev"
            / "tor"
            / "torrc"
        )

        torrc.write_text(
            "ControlPort 9051\n",
            encoding="utf-8",
        )

        with self.assertRaises(
            profile_tool.ProfileError
        ):
            profile_tool.prepare(
                self.root
            )

        self.assertEqual(
            torrc.read_text(
                encoding="utf-8"
            ),
            "ControlPort 9051\n",
        )

    def test_missing_repository_is_rejected(self):
        (
            self.root / "package.json"
        ).unlink()

        with self.assertRaises(
            profile_tool.ProfileError
        ):
            profile_tool.prepare(
                self.root
            )


if __name__ == "__main__":
    unittest.main()