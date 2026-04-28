# Nexus Parliament

A multi-model adversarial reasoning engine using the Blackboard pattern.

## Architecture

- **Blackboard**: Shared state holding the topic, all turns, conflicts, and metadata.
- **Orchestrator**: Schedules the Proposer → Skeptic → Synthesizer cycle; injects the Red Agent every 3 turns.
- **Sentry**: Lightweight monitor that detects echo loops and convergence collapse after each Synthesizer turn.
- **OSI (Opinion Stability Index)**: Embeds turn content and measures cosine similarity drift to flag premature consensus.

## Agents

| Agent       | Default model        | Role                                          |
|-------------|----------------------|-----------------------------------------------|
| Proposer    | llama3.2             | Opens with a position                         |
| Skeptic     | mistral              | Challenges the current position               |
| Synthesizer | qwen2.5              | Attempts integration or marks irreconcilable splits |
| Red Agent   | mistral-openorca     | Adversarial injection to disrupt consensus    |
| Sentry      | tinyllama            | Echo-loop + convergence monitor               |

## Success Metric

"Residue of Conflict" — unresolved splits are valid, recorded outputs. The engine does not force
convergence. `blackboard.residue` captures the final unresolved tension if `blackboard.resolved` is `False`.

## Usage

```bash
pip install -e .
python examples/run_debate.py
```

Requires [Ollama](https://ollama.ai) running locally on port 11434.

## Models to pull

```bash
ollama pull llama3.2
ollama pull mistral
ollama pull qwen2.5
ollama pull mistral-openorca
ollama pull tinyllama
```
