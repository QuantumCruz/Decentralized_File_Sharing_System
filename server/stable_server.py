"""Production backend for FileShare 1.0.0.

Uses separate storage and ports from legacy and Preview installations.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re

from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from aiohttp import web

from server.server_persistent import (
    FileShare,
    create_owner_app,
    create_public_app,
)


PORTS = {
    "owner": 35300,
    "public": 35302,
    "ipfs_api": 35301,
    "ipfs_gateway": 38081,
    "ipfs_swarm": 34001,
    "tor_control": 39351,
    "tor_socks": 39350,
}

ONION_RE = re.compile(r"[a-z2-7]{56}\Z")


@dataclass(frozen=True)
class StableSettings:
    root: Path
    database: Path
    temporary: Path
    build: Path
    token: str
    onion: str
    clearnet: str | None


def load_settings(
    environ: dict[str, str] | os._Environ[str],
) -> StableSettings:
    local = environ.get("LOCALAPPDATA", "")

    if not local:
        raise RuntimeError("LOCALAPPDATA is missing")

    base = Path(local).resolve(strict=True)
    root = base / "QuantumCruz" / "FileShare"

    expected = {
        "FILESHARE_MODE": "stable",
        "FILESHARE_DATA_ROOT": str(root),
        "FILESHARE_DB_PATH": str(
            root / "state" / "metadata.db"
        ),
        "FILESHARE_TEMP_DIR": str(
            root / "temporary"
        ),
        "FILESHARE_IPFS_API": (
            "http://127.0.0.1:35301/api/v0"
        ),
        "FILESHARE_OWNER_HOST": "127.0.0.1",
        "FILESHARE_PUBLIC_HOST": "127.0.0.1",
        "FILESHARE_OWNER_PORT": "35300",
        "FILESHARE_PUBLIC_PORT": "35302",
        "FILESHARE_TOR_CONTROL_PORT": "39351",
        "IPFS_PATH": str(root / "ipfs"),
    }

    for key, value in expected.items():
        if environ.get(key) != value:
            raise RuntimeError(
                f"Invalid production environment: {key}"
            )

    for target in (
        root.parent,
        root,
        root / "state",
        root / "ipfs",
        root / "temporary",
    ):
        if (
            target.exists()
            and target.resolve(strict=True) != target
        ):
            raise RuntimeError(
                f"Redirected application data directory: {target}"
            )

    build = Path(
        environ.get("FILESHARE_BUILD_DIR", "")
    )

    if (
        not build.is_absolute()
        or not (build / "index.html").is_file()
    ):
        raise RuntimeError(
            "Production frontend assets are missing"
        )

    token = environ.get(
        "FILESHARE_ADMIN_TOKEN", ""
    )

    if len(token) < 32:
        raise RuntimeError(
            "Missing owner authentication token"
        )

    onion = environ.get(
        "FILESHARE_ONION_HOST", ""
    ).lower()

    if not ONION_RE.fullmatch(onion):
        raise RuntimeError(
            "Missing or invalid Onion hostname"
        )

    clearnet = (
        environ.get("CLEARNET_URL", "").rstrip("/")
        or None
    )

    if clearnet:
        url = urlparse(clearnet)

        if (
            url.scheme != "https"
            or not url.hostname
            or not url.hostname.endswith(
                ".trycloudflare.com"
            )
            or url.username
            or url.password
            or url.port
            or url.path
            or url.query
            or url.fragment
        ):
            raise RuntimeError(
                "Invalid HTTPS tunnel address"
            )

    return StableSettings(
        root=root,
        database=root / "state" / "metadata.db",
        temporary=root / "temporary",
        build=build,
        token=token,
        onion=onion,
        clearnet=clearnet,
    )


async def serve(
    settings: StableSettings,
) -> None:
    service = FileShare(
        db_path=settings.database,
        temp_dir=settings.temporary,
        build_dir=settings.build,
        ipfs_api=(
            "http://127.0.0.1:35301/api/v0"
        ),
        token=settings.token,
        tor_port=PORTS["tor_control"],
        clearnet_url=settings.clearnet,
    )

    service.onion = settings.onion

    public = web.AppRunner(
        create_public_app(service)
    )

    owner = web.AppRunner(
        create_owner_app(service)
    )

    await public.setup()

    try:
        await web.TCPSite(
            public,
            "127.0.0.1",
            PORTS["public"],
        ).start()

        await owner.setup()

        try:
            await web.TCPSite(
                owner,
                "127.0.0.1",
                PORTS["owner"],
            ).start()

            logging.info(
                "FileShare production listeners started"
            )

            cleanup = asyncio.create_task(
                service.cleanup_expired()
            )

            try:
                await asyncio.Event().wait()

            finally:
                cleanup.cancel()

                await asyncio.gather(
                    cleanup,
                    return_exceptions=True,
                )

        finally:
            await owner.cleanup()

    finally:
        await public.cleanup()


def main() -> int:
    settings = load_settings(
        os.environ
    )

    log_dir = settings.root / "logs"

    log_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    logging.basicConfig(
        filename=str(
            log_dir / "backend.log"
        ),
        level=logging.INFO,
        format=(
            "%(asctime)s %(levelname)s "
            "%(name)s: %(message)s"
        ),
        encoding="utf-8",
    )

    try:
        asyncio.run(
            serve(settings)
        )

    except KeyboardInterrupt:
        return 0

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())

    except Exception:
        import traceback

        local = os.environ.get(
            "LOCALAPPDATA"
        )

        if local:
            try:
                folder = (
                    Path(local)
                    / "QuantumCruz"
                    / "FileShare"
                    / "logs"
                )

                folder.mkdir(
                    parents=True,
                    exist_ok=True,
                )

                with (
                    folder / "backend-startup-error.log"
                ).open(
                    "a",
                    encoding="utf-8",
                ) as output:
                    traceback.print_exc(
                        file=output
                    )

            except OSError:
                pass

        raise SystemExit(1)