"""Online quality judges that sample agent turns and store a score per
judge in DDB. Fire-and-forget at end-of-turn; a judge failure must
never affect the user response. See judge_runner for the orchestrator.
Parity with Jockey's `scoring/` module.
"""
from .judge_runner import maybe_judge_turn

__all__ = ["maybe_judge_turn"]
