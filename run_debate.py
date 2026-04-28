#!/usr/bin/env python3
"""Parliament debate runner (Python).

Reads agent definitions from parliament.toml and runs an adversarial
multi-model debate using whichever provider is selected via the
PARLIAMENT_PROVIDER environment variable (default: ollama).

Usage:
    python run_debate.py "<topic>" [--rounds N] [--config PATH]
                         [--roles proposer,skeptic,synthesizer]
                         [--provider ollama|lm_studio|omlx]

Environment variables:
    PARLIAMENT_PROVIDER   — "ollama" | "lm_studio" | "omlx"  (default: ollama)
    PARLIAMENT_CONFIG     — path to parliament.toml            (default: parliament.toml)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:
    try:
        import tomli as tomllib  # type: ignore[no-redef]
    except ModuleNotFoundError:
        tomllib = None  # type: ignore[assignment]

from parliament.providers import get_provider


# ---------------------------------------------------------------------------
# TOML config loading (stdlib-only fallback for Python < 3.11)
# ---------------------------------------------------------------------------

def _parse_toml_stdlib(text: str) -> dict:
    """Minimal TOML parser that handles only the parliament.toml structure.

    Supports:
        [section.subsection]
        key = "value"
    """
    result: dict = {}
    current_section: dict = result
    current_path: list[str] = []

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        if line.startswith("[") and line.endswith("]"):
            parts = line[1:-1].split(".")
            current_path = parts
            # Ensure nested dicts exist
            node = result
            for part in parts:
                node = node.setdefault(part, {})
            current_section = node
            continue

        if "=" in line:
            key, _, raw_value = line.partition("=")
            key = key.strip()
            raw_value = raw_value.strip()
            # Handle quoted strings only (sufficient for parliament.toml)
            if raw_value.startswith('"') and raw_value.endswith('"'):
                value: str = raw_value[1:-1]
            else:
                value = raw_value
            current_section[key] = value

    return result


def load_toml(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    if tomllib is not None:
        if hasattr(tomllib, "loads"):
            return tomllib.loads(text)  # type: ignore[attr-defined]
        return tomllib.loads(text)
    # Fall back to the built-in minimal parser
    return _parse_toml_stdlib(text)


def load_config(config_path: str | None = None) -> dict:
    raw_path = (
        config_path
        or os.environ.get("PARLIAMENT_CONFIG")
        or "parliament.toml"
    )
    path = Path(raw_path)
    if not path.is_absolute():
        path = Path(__file__).parent / path
    if not path.exists():
        sys.exit(f"Parliament: config not found at {path}")
    return load_toml(path)


# ---------------------------------------------------------------------------
# Debate logic
# ---------------------------------------------------------------------------

def build_prompt(topic: str, history: list[dict], agent_name: str) -> str:
    if not history:
        return (
            f'You are participating in a structured debate on the following topic:\n\n'
            f'"{topic}"\n\n'
            f"You are {agent_name}. Please provide your opening position."
        )
    history_text = "\n\n".join(f"[{t['agent']}]: {t['content']}" for t in history)
    return (
        f'You are participating in a structured debate on the following topic:\n\n'
        f'"{topic}"\n\n'
        f"Debate so far:\n\n{history_text}\n\n"
        f"You are {agent_name}. Please respond to the above."
    )


def run_debate(
    topic: str,
    agents: list[dict],
    max_rounds: int = 3,
    transcripts_dir: str = "transcripts",
) -> dict:
    """Run an adversarial multi-agent debate.

    Args:
        topic: The debate topic/question.
        agents: List of dicts with keys: name, model, system_prompt, provider.
        max_rounds: Number of full rounds to run.
        transcripts_dir: Directory in which to save the JSON transcript.

    Returns:
        A dict matching the DeliberationResult shape from the TS core package.
    """
    turns: list[dict] = []

    print(f'\nParliament debate: "{topic}"')
    print("─" * 60)

    for round_idx in range(max_rounds):
        for agent in agents:
            prompt = build_prompt(topic, turns, agent["name"])
            content = agent["provider"].generate(
                agent["model"], prompt, agent["system_prompt"]
            )

            turn = {
                "agent": agent["name"],
                "neurotype": agent["name"],
                "model": agent["model"],
                "content": content,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }

            # Print immediately (streaming feel)
            print(f"\n[{agent['name']} / {agent['model']}]")
            print(content)

            turns.append(turn)

    result = {
        "topic": topic,
        "turns": turns,
        "conflicts": [],
        "residue": [],
        "resolved": True,
        "total_rounds": max_rounds,
        "termination_reason": "max_rounds",
    }

    # Save transcript
    transcripts_path = Path(transcripts_dir)
    transcripts_path.mkdir(parents=True, exist_ok=True)
    slug = topic[:40].lower().replace(" ", "-").replace('"', "")
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    filepath = transcripts_path / f"{slug}-{ts}.json"
    filepath.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"\n[transcript saved → {filepath}]")

    return result


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="run_debate.py",
        description="Parliament adversarial debate runner (Python).",
    )
    parser.add_argument("topic", help='The debate topic, e.g. "Is consciousness computable?"')
    parser.add_argument("--rounds", "-r", type=int, default=3, metavar="N",
                        help="Number of debate rounds (default: 3)")
    parser.add_argument("--config", "-c", default=None, metavar="PATH",
                        help="Path to parliament.toml (default: parliament.toml)")
    parser.add_argument("--transcripts", "-t", default="transcripts", metavar="DIR",
                        help="Directory for JSON transcripts (default: transcripts)")
    parser.add_argument("--roles", default=None, metavar="a,b,c",
                        help="Comma-separated neurotype roles (default: proposer,skeptic,synthesizer)")
    parser.add_argument("--provider", default=None, metavar="NAME",
                        help="Provider override: ollama | lm_studio | omlx "
                             "(overrides PARLIAMENT_PROVIDER env var)")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv if argv is not None else sys.argv[1:])

    config = load_config(args.config)
    neurotypes: dict = config.get("neurotypes", {})

    if not neurotypes:
        sys.exit("Parliament: no [neurotypes] found in parliament.toml")

    # Determine which roles to run
    if args.roles:
        selected_roles = [r.strip() for r in args.roles.split(",") if r.strip()]
    else:
        # Default order mirrors the TS CLI: proposer → skeptic → synthesizer
        preferred = ["proposer", "skeptic", "synthesizer"]
        selected_roles = [r for r in preferred if r in neurotypes] or list(neurotypes.keys())

    # Build one shared provider instance (all agents share the same backend)
    provider = get_provider(args.provider)

    agents = []
    for role in selected_roles:
        if role not in neurotypes:
            sys.exit(
                f"Parliament: unknown neurotype '{role}'. "
                f"Available: {', '.join(neurotypes.keys())}"
            )
        nt = neurotypes[role]
        agents.append({
            "name": role,
            "model": nt["model"],
            "system_prompt": nt.get("system_prompt", ""),
            "provider": provider,
        })

    if not agents:
        sys.exit("Parliament: no agents resolved — check your --roles argument.")

    run_debate(
        topic=args.topic,
        agents=agents,
        max_rounds=args.rounds,
        transcripts_dir=args.transcripts,
    )


if __name__ == "__main__":
    main()
