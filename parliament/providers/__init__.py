"""Parliament model providers.

Usage:
    from parliament.providers import get_provider

    provider = get_provider()                  # uses PARLIAMENT_PROVIDER env var, defaults to "ollama"
    reply = provider.generate("llama3.2", "What is 2+2?")

Supported provider names:
    "ollama"    — OllamaProvider    (http://localhost:11434)
    "lm_studio" — LMStudioProvider  (http://localhost:1234/v1)
    "omlx"      — oMLXProvider      (http://localhost:8080/v1)
"""

import os

from .base import BaseModelProvider
from .errors import ModelConnectionError
from .lm_studio import LMStudioProvider
from .ollama import OllamaProvider
from .omlx import oMLXProvider

__all__ = [
    "BaseModelProvider",
    "ModelConnectionError",
    "OllamaProvider",
    "LMStudioProvider",
    "oMLXProvider",
    "get_provider",
]


def get_provider(name: str | None = None) -> BaseModelProvider:
    """Return a provider instance selected by name or the PARLIAMENT_PROVIDER env var.

    Resolution order:
      1. The explicit ``name`` argument (if given).
      2. The ``PARLIAMENT_PROVIDER`` environment variable.
      3. Defaults to ``"ollama"``.

    Args:
        name: One of ``"ollama"``, ``"lm_studio"``, or ``"omlx"``.

    Returns:
        A ready-to-use :class:`BaseModelProvider` instance.

    Raises:
        ValueError: If ``name`` is not a recognised provider identifier.
    """
    provider = name or os.environ.get("PARLIAMENT_PROVIDER", "ollama")

    if provider == "ollama":
        return OllamaProvider()
    if provider == "lm_studio":
        return LMStudioProvider()
    if provider == "omlx":
        return oMLXProvider()

    raise ValueError(
        f"Unknown provider: {provider!r}. "
        "Valid options are: 'ollama', 'lm_studio', 'omlx'."
    )
