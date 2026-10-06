"""Root-secret resolution for the Cognitive OS kernel.

The kernel used to default to ``"avaira-v5-hardware-root-of-trust"`` — a literal that ships
in this repository. Everything the kernel signs (safety certificates, enclave attestations)
could therefore be minted by anyone who read the source, which silently invalidated the
"signature-valid certificate" pillar: the offline demo only refused the attacker because it
happened to sign with a *different* string.

Resolution order: ``AVAIRA_OS_SECRET`` → ``<data dir>/os_secret`` (created 0600 on first use)
→ hard error. There is deliberately no shared default.

Kept dependency-free on purpose: the kernel must not import the backend application.
"""
from __future__ import annotations

import os
import secrets
import stat
from pathlib import Path
from typing import Tuple


class MissingKernelSecretError(RuntimeError):
    """Raised when no root secret can be resolved."""


def data_dir() -> Path:
    override = os.environ.get("AVAIRA_DATA_DIR", "").strip()
    return Path(override) if override else Path.home() / ".avaira"


def resolve_root_secret() -> Tuple[str, str]:
    """Return ``(secret, source)`` where source is ``"env"`` or ``"file"``."""
    value = os.environ.get("AVAIRA_OS_SECRET", "").strip()
    if value:
        if len(value) < 16:
            raise MissingKernelSecretError("AVAIRA_OS_SECRET is too short; use at least 16 characters")
        return value, "env"

    path = data_dir() / "os_secret"
    try:
        if path.exists():
            existing = path.read_text(encoding="utf-8").strip()
            if existing:
                return existing, "file"
        generated = secrets.token_hex(32)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(generated, encoding="utf-8")
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
        return generated, "file"
    except OSError as exc:  # pragma: no cover - depends on the host filesystem
        raise MissingKernelSecretError(
            f"AVAIRA_OS_SECRET is not set and {path} is not writable. "
            "Set AVAIRA_OS_SECRET, or make the data directory writable."
        ) from exc
