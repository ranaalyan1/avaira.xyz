"""Per-installation secret storage.

Several components previously fell back to a *hard-coded* secret when their
environment variable was missing:

    AVAIRA_LOG_SECRET  -> "default_secret_32_bytes_long_!!!!!"   (AES-GCM audit log + agent signing keys)
    witness seed       -> sha256(witness_id)                     (forges any witness signature)
    ZK secret          -> "zk-avaira-secret-v2"
    TEE secret         -> "hardware-root-of-trust-0x1337"

Because those literals live in a public repository, every deployment shared the
same keys: anyone could decrypt audit logs, forge agent audit signatures, forge
witness co-signatures and mint "verifiable" compliance proofs.

This module resolves a secret in the following order:

1. the environment variable, when set (what production should use, ideally fed
   from a real secret manager);
2. a locally generated ``<data_dir>/<filename>`` file, created with 0600
   permissions on first use, so a dev/self-hosted install still gets a secret
   that is unique to the *installation* rather than to the repository;
3. otherwise it raises — there is deliberately no shared default.

Set ``AVAIRA_DATA_DIR`` to control where the generated files live
(default: ``~/.avaira``).
"""

from __future__ import annotations

import os
import secrets
import stat
from pathlib import Path
from typing import Optional, Tuple


class MissingSecretError(RuntimeError):
    """Raised when no secret can be resolved without falling back to a shared default."""


def data_dir() -> Path:
    override = os.environ.get("AVAIRA_DATA_DIR", "").strip()
    return Path(override) if override else Path.home() / ".avaira"


def get_or_create_secret(
    env_var: str,
    filename: str,
    *,
    min_length: int = 16,
    generator=None,
    allow_ephemeral: bool = False,
) -> Tuple[str, str]:
    """Resolve ``env_var`` or a generated per-installation secret.

    Returns ``(secret, source)`` where source is one of ``"env"``, ``"file"`` or
    ``"ephemeral"`` (the last only when ``allow_ephemeral`` is set and the data
    directory is not writable — useful for read-only demo containers, never for
    production).
    """
    value = os.environ.get(env_var, "").strip()
    if value:
        if len(value) < min_length:
            raise MissingSecretError(
                f"{env_var} is too short ({len(value)} chars); use at least {min_length} characters"
            )
        return value, "env"

    path = data_dir() / filename
    try:
        if path.exists():
            existing = path.read_text(encoding="utf-8").strip()
            if existing:
                return existing, "file"
        secret = (generator or secrets.token_hex)(32) if generator else secrets.token_hex(32)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(secret, encoding="utf-8")
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
        return secret, "file"
    except OSError:
        if allow_ephemeral:
            return secrets.token_hex(32), "ephemeral"
        raise MissingSecretError(
            f"{env_var} is not set and no secret could be persisted to {path}. "
            f"Set {env_var} (recommended) or make {path.parent} writable."
        )


def secret_file_path(filename: str) -> Optional[str]:
    """Absolute path of the generated secret file, when it exists (never the secret itself)."""
    path = data_dir() / filename
    return str(path) if path.exists() else None
