"""Hatch build hook: ship the built React frontend inside the package.

The UI is built separately with Node (``npm ci && npm run build`` in
``../frontend``). This hook only copies the result into the distribution as
``openkb_web/static/``, which ``openkb_web.main`` serves at runtime:

- sdist from a source checkout: ``../frontend/dist`` -> ``openkb_web/static/``
- wheel from that sdist (what ``uv build`` / ``python -m build`` do by
  default): the sdist already carries ``openkb_web/static/``, used as is
- wheel straight from a source checkout: ``../frontend/dist`` again

Editable installs (``uv sync``, ``pip install -e``) are skipped: they run from
the checkout, where the server finds ``../frontend/dist`` or the Vite dev
server is used instead.

A non-editable build without the built frontend fails instead of silently
producing a package with no UI.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

# Must match openkb_web.main._PACKAGED_FRONTEND.
PACKAGED_FRONTEND = "openkb_web/static"


class FrontendBuildHook(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        if self.target_name == "wheel" and version == "editable":
            return

        root = Path(self.root)
        if (root / "PKG-INFO").is_file():
            # Building from an unpacked sdist: the assets are already inside.
            source = root / PACKAGED_FRONTEND
            hint = (
                "This sdist is missing its bundled frontend; rebuild it from a "
                "source checkout after building the frontend."
            )
        else:
            source = (root.parent / "frontend" / "dist").resolve()
            hint = (
                "Build the frontend first, then build the package again:\n"
                "    cd frontend && npm ci && npm run build"
            )

        if not (source / "index.html").is_file():
            raise RuntimeError(
                f"openkb-web: built frontend not found at {source}. "
                f"Refusing to build the {self.target_name} without the web UI.\n{hint}"
            )

        build_data["force_include"][str(source)] = PACKAGED_FRONTEND
