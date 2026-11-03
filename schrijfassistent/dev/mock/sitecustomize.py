"""PYTHONPATH-injected AI mock for the backend.

Python imports `sitecustomize` from sys.path at interpreter start-up, so putting this directory first on
PYTHONPATH makes the hook run before `main.py` or `uvicorn` import anything. It installs a `sys.meta_path`
finder that intercepts the import of `app.services.ai_agent` and serves `mock_ai_agent.py` instead, whose
module-level `ai_agent` object has the two attributes `storage.py` uses:

    ai_agent.client               truthy (the routes check `if ai_agent.client`)
    ai_agent.get_agent_response   (prompt: str) -> str

The backend source is not modified and `azure.ai.projects` / `openai` are never imported. Set AI_MOCK=0 to
disable the hook. Fixture selection is described in mock_ai_agent.py.
"""
from __future__ import annotations

import importlib.abc
import importlib.util
import os
import sys
from pathlib import Path

_TARGET = os.environ.get("AI_MOCK_MODULE", "app.services.ai_agent")
_HERE = Path(__file__).resolve().parent


class _MockFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path, target=None):
        if fullname != _TARGET:
            return None
        spec = importlib.util.spec_from_file_location(fullname, _HERE / "mock_ai_agent.py")
        return spec


if os.environ.get("AI_MOCK", "1") != "0":
    sys.meta_path.insert(0, _MockFinder())
    sys.stderr.write(f"[ai-mock] {_TARGET} will be served by {_HERE / 'mock_ai_agent.py'}\n")
