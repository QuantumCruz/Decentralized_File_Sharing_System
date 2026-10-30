"""Run FileShare's isolated development HTTP services.

Never opens production configuration or discovers system-wide Tor/IPFS daemons.
The Electron development launcher owns network process startup.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import re
from pathlib import Path
from urllib.parse import urlparse

from aiohttp import web

from server.dev_runtime import load_development_runtime
from server.server_persistent import (
    FileShare,
    create_owner_app,
    create_public_app,
)

LOG = logging.getLogger("fileshare.dev")
ONION_RE = re.compile(r"^[a-z2-7]{56}$")


def validate_environment(runtime) -> tuple[str, str, str | None]:
    expected = {
        "FILESHARE_MODE": "development",
        "FILESHARE_DEV_PROFILE": str(runtime.workspace / "runtime.json"),
        "FILESHARE_DB_PATH": str(runtime.database),
        "FILESHARE_TEMP_DIR": str(runtime.temporary),
        "FILESHARE_IPFS_API": runtime.ipfs_api_url,
        "FILESHARE_OWNER_HOST": "127.0.0.1",
        "FILESHARE_PUBLIC_HOST": "127.0.0.1",
        "FILESHARE_OWNER_PORT": str(runtime.ports["owner"]),
        "FILESHARE_PUBLIC_PORT": str(runtime.ports["public"]),
        "FILESHARE_TOR_CONTROL_PORT": str(runtime.ports["tor_control"]),
        "IPFS_PATH": str(runtime.ipfs_repo),
        "TMP": str(runtime.temporary),
        "TEMP": str(runtime.temporary),
    }

    for key, value in expected.items():
        if os.environ.get(key) != value:
            raise RuntimeError(
                f"Development environment mismatch: {key}"
            )

    token = os.environ.get("FILESHARE_ADMIN_TOKEN", "")
    if len(token) < 32:
        raise RuntimeError("Missing owner authentication token")

    onion = os.environ.get("FILESHARE_ONION_HOST", "").lower()
    if not ONION_RE.fullmatch(onion):
        raise RuntimeError("Invalid or missing development Onion hostname")

    clearnet = os.environ.get("CLEARNET_URL", "").rstrip("/") or None
    if clearnet:
        parsed = urlparse(clearnet)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or not parsed.hostname.endswith(".trycloudflare.com")
            or parsed.username
            or parsed.password
            or parsed.port
            or parsed.path
            or parsed.query
            or parsed.fragment
        ):
            raise RuntimeError("Unexpected development Cloudflare address")

    return token, onion, clearnet


async def serve(
    runtime,
    token: str,
    onion: str,
    clearnet: str | None,
) -> None:
    service = FileShare(
        db_path=runtime.database,
        temp_dir=runtime.temporary,
        build_dir=runtime.root / "server" / "build",
        ipfs_api=runtime.ipfs_api_url,
        token=token,
        tor_port=runtime.ports["tor_control"],
        clearnet_url=clearnet,
    )
    service.onion = onion

    public_runner = web.AppRunner(create_public_app(service))
    owner_runner = web.AppRunner(create_owner_app(service))

    await public_runner.setup()

    try:
        await web.TCPSite(
            public_runner,
            "127.0.0.1",
            runtime.ports["public"],
        ).start()

        await owner_runner.setup()

        try:
            await web.TCPSite(
                owner_runner,
                "127.0.0.1",
                runtime.ports["owner"],
            ).start()

            LOG.info("Development owner and public listeners ready")

            cleanup = asyncio.create_task(service.cleanup_expired())

            try:
                await asyncio.Event().wait()
            finally:
                cleanup.cancel()
                await asyncio.gather(cleanup, return_exceptions=True)

        finally:
            await owner_runner.cleanup()

    finally:
        await public_runner.cleanup()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Isolated FileShare development server"
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate profile only; start nothing",
    )
    args = parser.parse_args()

    runtime = load_development_runtime(
        Path(__file__).resolve().parents[1]
    )

    if args.check:
        print(
            "Development server profile OK: "
            f"{runtime.owner_url} / {runtime.public_url}"
        )
        print("No services or subprocesses started.")
        return 0

    token, onion, clearnet = validate_environment(runtime)

    logging.basicConfig(level=logging.INFO)

    try:
        asyncio.run(serve(runtime, token, onion, clearnet))
    except KeyboardInterrupt:
        return 0

    return 0


if __name__ == "__main__":
    raise SystemExit(main())