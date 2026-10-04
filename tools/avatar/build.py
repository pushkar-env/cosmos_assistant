"""Entry point: rebuild the Nova avatar from scratch inside Blender.

Run from Blender's Python (or the Blender MCP bridge):

    exec(open(r"<repo>/tools/avatar/build.py").read())

Set ``NOVA_STEPS`` before exec'ing to stop early while iterating, e.g.
``NOVA_STEPS = {"head", "face"}``.
"""

import importlib
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else None
if ROOT is None:
    ROOT = NOVA_ROOT  # noqa: F821 — injected by the caller when exec'ing
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import nova  # noqa: E402

for name in sorted(list(sys.modules)):
    if name == "nova" or name.startswith("nova."):
        importlib.reload(sys.modules[name])
importlib.reload(nova)

from nova import pipeline  # noqa: E402

importlib.reload(pipeline)
NOVA_RESULT = pipeline.run(globals().get("NOVA_STEPS"))
