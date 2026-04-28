from __future__ import annotations

from dataclasses import dataclass

from parliament.blackboard import Blackboard
from parliament.metrics.osi import compute_osi
from parliament.models.ollama import OllamaModel

from .base import BaseAgent

OSI_CONVERGENCE_THRESHOLD = 0.95


@dataclass
class SentryResult:
    converged: bool
    reason: str


class Sentry(BaseAgent):
    def __init__(self, model_name: str = "tinyllama") -> None:
        super().__init__(name="Sentry", neurotype="monitor", model_name=model_name)
        self._model = OllamaModel(model_name)

    def check(self, blackboard: Blackboard) -> SentryResult:
        if blackboard.detect_echo_loop():
            return SentryResult(converged=True, reason="echo loop detected: same agent pair repeating")

        if len(blackboard.turns) >= 4:
            osi = compute_osi(blackboard.turns)
            if osi is not None and osi > OSI_CONVERGENCE_THRESHOLD:
                return SentryResult(
                    converged=True,
                    reason=f"OSI={osi:.3f} exceeds threshold {OSI_CONVERGENCE_THRESHOLD}",
                )

        return SentryResult(converged=False, reason="ok")

    # generate() satisfies the ABC; not used in normal operation
    def generate(self, blackboard: Blackboard) -> str:
        prompt = self.build_prompt(blackboard) + "\n\nBriefly flag any reasoning loop or false consensus you observe."
        return self._model.generate(prompt)
