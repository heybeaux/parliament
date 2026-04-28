from abc import ABC, abstractmethod


class BaseModelProvider(ABC):
    """Abstract base class for all model providers.

    Implementations must hit their respective inference backend and return the
    model's reply as a plain string.
    """

    @abstractmethod
    def generate(self, model: str, prompt: str, system: str = "") -> str:
        """Generate a response from the model.

        Args:
            model: The model identifier (e.g. "llama3.2", "mistral").
            prompt: The user-turn content.
            system: Optional system prompt injected before the user turn.

        Returns:
            The model's reply as a string.

        Raises:
            ModelConnectionError: If the provider is unreachable or returns an error.
        """
        ...
