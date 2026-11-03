"""PyInstaller runtime hook: opt-in, offline verification before app startup.

The normal application path only defines this function. Packaging invokes the
explicit flag to exercise the actual frozen libraries without downloading model
weights, opening a server, or reading/writing the user's application state.
"""

import sys


def verify_runtime() -> None:
    import json
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo

    import imagehash
    import numpy as np
    import onnxruntime as ort
    from PIL import Image
    from platformdirs import user_data_dir
    from scipy.special import ndtr
    from tokenizers import Tokenizer, models

    if not user_data_dir("MediaSorter"):
        raise RuntimeError("platform directory lookup failed")
    if datetime(2026, 1, 1, tzinfo=ZoneInfo("Europe/Berlin")).utcoffset() != timedelta(hours=1):
        raise RuntimeError("IANA time-zone data is unavailable")
    if float(ndtr(0.0)) != 0.5 or len(str(imagehash.phash(Image.new("RGB", (32, 32))))) != 16:
        raise RuntimeError("frozen image/SciPy runtime failed")
    tokenizer = Tokenizer(models.WordLevel({"hello": 0, "[UNK]": 1}, unk_token="[UNK]"))
    if tokenizer.encode("hello").ids != [0]:
        raise RuntimeError("frozen tokenizer failed")
    if "CPUExecutionProvider" not in ort.get_available_providers():
        raise RuntimeError("ONNX CPU execution provider is unavailable")

    # An authored, tiny ONNX Identity graph: float[1] x -> y, IR 8, opset 13.
    # Encode its short protobuf fields directly so the shipped inference-only
    # runtime does not acquire an ONNX model-authoring dependency for this check.
    def field(number: int, value: bytes) -> bytes:
        return bytes((number * 8 + 2, len(value))) + value

    tensor = b"\x08\x01" + field(2, field(1, b"\x08\x01"))
    node = field(1, b"x") + field(2, b"y") + field(4, b"Identity")
    graph = field(1, node) + field(2, b"runtime-check")
    graph += field(11, field(1, b"x") + field(2, field(1, tensor)))
    graph += field(12, field(1, b"y") + field(2, field(1, tensor)))
    model = b"\x08\x08" + field(7, graph) + field(8, b"\x10\x0d")
    session = ort.InferenceSession(model, providers=["CPUExecutionProvider"])
    value = np.array([3.0], dtype=np.float32)
    if not np.array_equal(session.run(None, {"x": value})[0], value):
        raise RuntimeError("frozen ONNX inference failed")
    print(json.dumps({"frozen_runtime": "ok"}))


if sys.argv[1:] == ["--verify-frozen-runtime"]:
    verify_runtime()
    raise SystemExit(0)
