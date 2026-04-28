import json
import urllib.error
import urllib.request

from .base import BaseModelProvider
from .errors import ModelConnectionError


class oMLXProvider(BaseModelProvider):
    """Provider for oMLX's OpenAI-compatible local server.

    Default endpoint: http://localhost:8080/v1/chat/completions
    Response shape follows the OpenAI chat completions spec:
    {"choices": [{"message": {"role": "...", "content": "..."}}]}
    """

    def __init__(
        self,
        base_url: str = "http://localhost:8080/v1",
        api_key: str = "local",
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key

    def generate(self, model: str, prompt: str, system: str = "") -> str:
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        payload = json.dumps({"model": model, "messages": messages}).encode()

        req = urllib.request.Request(
            url=f"{self._base_url}/chat/completions",
            data=payload,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._api_key}",
            },
        )

        try:
            with urllib.request.urlopen(req) as resp:
                body = json.loads(resp.read().decode())
        except urllib.error.URLError as exc:
            raise ModelConnectionError(
                f"oMLX connection failed: {exc.reason}"
            ) from exc
        except Exception as exc:
            raise ModelConnectionError(
                f"oMLX request error: {exc}"
            ) from exc

        try:
            return body["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ModelConnectionError(
                f"Unexpected oMLX response shape: {body!r}"
            ) from exc
