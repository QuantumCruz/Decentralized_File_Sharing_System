"""Prepare and validate an isolated FileShare development runtime.

This command deliberately never launches Tor, IPFS, Electron, or the backend.
The development launchers will consume runtime.json in Stage 1.
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
import tempfile
from pathlib import Path


PORTS = {
    "owner": 15300,
    "public": 15302,
    "ipfs_api": 15301,
    "ipfs_gateway": 18081,
    "ipfs_swarm": 14001,
    "tor_control": 19351,
    "tor_socks": 19350,
}

RESERVED_PRODUCTION_PORTS = {
    5000, 5001, 5002, 4001, 8080, 9050, 9051
}


class ProfileError(Exception):
    """Development isolation precondition failed."""


def project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def _paths(root: Path) -> dict[str, str]:
    workspace = root / ".fileshare-dev"

    return {
        "workspace": str(workspace),
        "database": str(workspace / "state" / "metadata.db"),
        "ipfs_repo": str(workspace / "ipfs"),
        "tor_data": str(workspace / "tor" / "data"),
        "torrc": str(workspace / "tor" / "torrc"),
        "logs": str(workspace / "logs"),
        "temporary": str(workspace / "temporary"),
    }


def _torrc(profile: dict) -> str:
    tor_data = Path(
        profile["paths"]["tor_data"]
    ).as_posix()

    return (
        f'DataDirectory "{tor_data}"\n'
        'CookieAuthentication 1\n'
        f'ControlPort 127.0.0.1:{profile["ports"]["tor_control"]}\n'
        f'SocksPort 127.0.0.1:{profile["ports"]["tor_socks"]}\n'
        'Log notice stdout\n'
    )


def _atomic_write(path: Path, text: str) -> None:
    temp_name = None

    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as output:
            temp_name = Path(output.name)
            output.write(text)

        temp_name.replace(path)

    finally:
        if temp_name is not None:
            temp_name.unlink(missing_ok=True)


def _assert_repo(root: Path) -> None:
    if not (
        (root / "package.json").is_file()
        and (root / "server" / "server_persistent.py").is_file()
    ):
        raise ProfileError(
            "Run this script inside the cloned FileShare source tree; "
            "package.json or server/server_persistent.py is missing."
        )


def validate_profile(profile: dict, root: Path) -> None:
    root = root.resolve()
    expected_paths = _paths(root)

    if (
        profile.get("version") != 1
        or profile.get("profile") != "development"
    ):
        raise ProfileError(
            "Invalid development profile version or type."
        )

    if profile.get("project_root") != str(root):
        raise ProfileError(
            "Profile belongs to a different source checkout."
        )

    if profile.get("ports") != PORTS:
        raise ProfileError(
            "Development ports differ from the isolated port policy."
        )

    if len(set(PORTS.values())) != len(PORTS):
        raise ProfileError(
            "Development ports must all be distinct."
        )

    if set(PORTS.values()) & RESERVED_PRODUCTION_PORTS:
        raise ProfileError(
            "A development port overlaps a production port."
        )

    if profile.get("paths") != expected_paths:
        raise ProfileError(
            "Development paths differ from the expected workspace."
        )

    workspace = Path(expected_paths["workspace"])

    for name, value in expected_paths.items():
        if name == "workspace":
            continue

        resolved = Path(value).resolve()

        if not _within(resolved, workspace):
            raise ProfileError(
                f"Development path escapes the workspace: {name}."
            )


def prepare(root: Path) -> Path:
    root = root.resolve()
    _assert_repo(root)

    profile = {
        "version": 1,
        "profile": "development",
        "project_root": str(root),
        "ports": dict(PORTS),
        "paths": _paths(root),
    }

    validate_profile(profile, root)
    paths = profile["paths"]

    for name in (
        "workspace",
        "ipfs_repo",
        "tor_data",
        "logs",
        "temporary",
    ):
        Path(paths[name]).mkdir(
            parents=True,
            exist_ok=True,
        )

    Path(paths["database"]).parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    torrc = Path(paths["torrc"])
    contents = _torrc(profile)

    if torrc.exists():
        if torrc.read_text(encoding="utf-8") != contents:
            raise ProfileError(
                "Existing development torrc differs from the "
                "expected configuration. Not overwriting it; "
                "inspect .fileshare-dev/tor/torrc."
            )
    else:
        _atomic_write(torrc, contents)

    manifest = (
        Path(paths["workspace"]) / "runtime.json"
    )

    if manifest.exists():
        try:
            existing = json.loads(
                manifest.read_text(encoding="utf-8")
            )
        except (ValueError, OSError) as exc:
            raise ProfileError(
                "Existing runtime.json is unreadable."
            ) from exc

        if existing != profile:
            raise ProfileError(
                "Existing development profile differs. "
                "Not overwriting your runtime data."
            )

    else:
        _atomic_write(
            manifest,
            json.dumps(profile, indent=2) + "\n",
        )

    return manifest


def verify(
    root: Path,
    check_ports: bool = True,
) -> dict:
    root = root.resolve()
    _assert_repo(root)

    manifest = (
        root / ".fileshare-dev" / "runtime.json"
    )

    if not manifest.is_file():
        raise ProfileError(
            "No development profile found. Run 'prepare' first."
        )

    try:
        profile = json.loads(
            manifest.read_text(encoding="utf-8")
        )
    except (ValueError, OSError) as exc:
        raise ProfileError(
            "Development profile is unreadable."
        ) from exc

    validate_profile(profile, root)

    paths = profile["paths"]
    torrc = Path(paths["torrc"])

    if (
        not torrc.is_file()
        or torrc.read_text(encoding="utf-8") != _torrc(profile)
    ):
        raise ProfileError(
            "Development Tor configuration is missing or unexpected."
        )

    for name in (
        "workspace",
        "ipfs_repo",
        "tor_data",
        "logs",
        "temporary",
    ):
        if not Path(paths[name]).is_dir():
            raise ProfileError(
                f"Missing development directory: {name}."
            )

    if check_ports:
        occupied = []

        for name, port in PORTS.items():
            with socket.socket(
                socket.AF_INET,
                socket.SOCK_STREAM,
            ) as listener:
                try:
                    listener.bind(
                        ("127.0.0.1", port)
                    )
                except OSError:
                    occupied.append(
                        f"{name}={port}"
                    )

        if occupied:
            raise ProfileError(
                "Development port(s) already occupied: "
                + ", ".join(occupied)
                + ". Do not stop your installed FileShare "
                "to free these ports."
            )

    return profile


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Prepare or verify an isolated "
            "FileShare Stage 1 development profile."
        )
    )

    parser.add_argument(
        "command",
        choices=("prepare", "verify"),
    )

    args = parser.parse_args()
    root = project_root()

    try:
        if args.command == "prepare":
            manifest = prepare(root)

            print(
                f"Prepared isolated FileShare profile: {manifest}"
            )

            print(
                "No application processes were started; "
                "installed FileShare is untouched."
            )

        else:
            profile = verify(root)

            print(
                "FileShare development profile verified."
            )

            print("Isolated listener ports:")

            for name, port in profile["ports"].items():
                print(
                    f"  {name}: 127.0.0.1:{port}"
                )

            print("No processes were started.")

        return 0

    except ProfileError as exc:
        print(
            f"ERROR: {exc}",
            file=sys.stderr,
        )

        return 1


if __name__ == "__main__":
    sys.exit(main())