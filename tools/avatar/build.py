"""Entry point: rebuild an avatar from scratch inside Blender.

Run from Blender's Python (or the Blender MCP bridge):

    AVATAR = "nova"            # or "tsunade" — any package with a spec.py
    exec(open(r"<repo>/tools/avatar/build.py").read())

Set ``NOVA_STEPS`` (list of step names) before exec'ing to stop early while
iterating, e.g. ``NOVA_STEPS = ["head", "face"]``. The result dict lands in
``NOVA_RESULT``.
"""

import importlib
import os
import sys

# an explicit NOVA_ROOT wins: when this file is exec'd from another script,
# __file__ is that script's path, not this one's
ROOT = globals().get("NOVA_ROOT") or os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

_character = globals().get("AVATAR", "nova")

# drop every cached kit/character module so edits are always picked up (a
# plain reload would leave cross-module imports pointing at stale code)
for _name in [n for n in list(sys.modules) if n.split(".")[0] in ("kit", "nova", "tsunade", _character)]:
    del sys.modules[_name]

import kit.pipeline  # noqa: E402

_spec = importlib.import_module(_character + ".spec")
NOVA_RESULT = kit.pipeline.run(_spec, globals().get("NOVA_STEPS"))
