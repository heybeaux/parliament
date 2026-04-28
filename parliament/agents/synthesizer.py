from __future__ import annotations

from parliament.blackboard import Blackboard
from parliament.models.ollama import OllamaModel

from .base import BaseAgent


class Synthesizer(BaseAgent):
    def __init__(self, model_name: str = "qwen2.5") -> None:
        super().__init__(
            name="Synthesizer", neurotype="integrator", model_name=model_name
        )
        self._model = OllamaModel(model_name)

    def generate(self, blackboard: Blackboard) -> str:
        prompt = self.build_prompt(blackboard) + (
            "\n\nAttempt to integrate the positions above into a coherent synthesis. "
            "If the split is irreconcilable, name the exact point of disagreement clearly "
            "and mark it as unresolved. Do not manufacture false consensus."
        )
        return self._model.generate(prompt)
