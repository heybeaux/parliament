from __future__ import annotations

from parliament.blackboard import Blackboard
from parliament.models.ollama import OllamaModel

from .base import BaseAgent


class Skeptic(BaseAgent):
    """Standard skeptic and adversarial red-agent share this base; role_hint differentiates."""

    def __init__(
        self,
        model_name: str = "mistral",
        name: str = "Skeptic",
        neurotype: str = "critic",
        role_hint: str = "Challenge the most recent claim with a pointed counterargument.",
    ) -> None:
        super().__init__(name=name, neurotype=neurotype, model_name=model_name)
        self._model = OllamaModel(model_name)
        self._role_hint = role_hint

    def generate(self, blackboard: Blackboard) -> str:
        prompt = self.build_prompt(blackboard) + f"\n\n{self._role_hint}"
        return self._model.generate(prompt)
