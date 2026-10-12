"""Hardware capability probe for AI model tier selection.

Detects CPU cores, RAM, and available ONNX execution providers once at startup,
then recommends a model tier so the app auto-disables or downgrades AI on weak
machines rather than hanging or OOM-ing.

Tier definitions:
  off      — machine is below the minimum (< 4 CPUs or < 3.5 GB RAM)
  standard — SigLIP 2 base/16 via onnxruntime (the one shipped model)

Saved ``lite`` and ``max`` values from older releases resolve to ``standard``.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from typing import Literal

from app.core.logging_config import get_logger

logger = get_logger(__name__)

#: `sysctl -n hw.memsize` prints one integer. Ten seconds is far beyond any
#: healthy response and short enough that a wedged call cannot stall startup.
_SYSCTL_TIMEOUT_SECONDS = 10

ModelTier = Literal["off", "standard"]

#: Saved settings from releases that offered more tiers. Both selected a model that
#: is no longer shipped (Lite, CLIP) or the same SigLIP model (Max).
LEGACY_TIER_ALIASES: dict[str, ModelTier] = {"lite": "standard", "max": "standard"}

_ACCELERATOR_EPS = {
    "CUDAExecutionProvider",
    "CoreMLExecutionProvider",
    "DmlExecutionProvider",
    "ROCMExecutionProvider",
    "TensorrtExecutionProvider",
}


def _ram_gb() -> float:
    """Best-effort total physical RAM in GB."""
    try:
        import psutil

        return float(psutil.virtual_memory().total) / (1024**3)
    except Exception:
        pass
    # Fallback: platform-specific stdlib approaches
    try:
        import platform

        if platform.system() == "Darwin":
            import subprocess

            # I-12: every subprocess call is bounded. `sysctl` returning a
            # single integer should take milliseconds; without a timeout a
            # wedged call would hang hardware detection, and hardware detection
            # runs during startup.
            out = subprocess.check_output(
                ["sysctl", "-n", "hw.memsize"], text=True, timeout=_SYSCTL_TIMEOUT_SECONDS
            )
            return int(out.strip()) / (1024**3)
        if sys.platform == "win32":
            import ctypes

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(stat)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
            return float(stat.ullTotalPhys) / (1024**3)
        # Linux: /proc/meminfo
        with open("/proc/meminfo") as fh:
            for line in fh:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) / (1024**2)
    except Exception:
        pass
    return 0.0


def _onnx_providers() -> list[str]:
    """Return available onnxruntime execution providers ([] if ort not installed)."""
    try:
        import onnxruntime as ort

        return list(ort.get_available_providers())
    except Exception:
        return []


def _has_accelerator(providers: list[str]) -> bool:
    """True if a hardware execution provider beyond the CPU EP is available."""
    return bool(_ACCELERATOR_EPS & set(providers))


def _recommend_tier(cpus: int, ram_gb: float, has_accel: bool) -> ModelTier:
    """Recommend the one shipped model where the machine can run it, else Off.

    ``has_accel`` no longer changes the model: acceleration only speeds up the
    same SigLIP 2 encoder.
    """
    del has_accel
    if cpus < 4 or ram_gb < 3.5:
        return "off"
    return "standard"


@dataclass(frozen=True)
class HardwareProfile:
    """Immutable snapshot of the machine's AI-relevant hardware."""

    logical_cpus: int
    total_ram_gb: float
    onnx_providers: list[str] = field(default_factory=list)
    has_accelerator: bool = False
    recommended_tier: ModelTier = "standard"

    @classmethod
    def probe(cls) -> HardwareProfile:
        """Probe the current machine and return a :class:`HardwareProfile`."""
        cpus = os.cpu_count() or 1
        ram_gb = _ram_gb()
        providers = _onnx_providers()
        has_accel = _has_accelerator(providers)
        tier = _recommend_tier(cpus, ram_gb, has_accel)
        profile = cls(
            logical_cpus=cpus,
            total_ram_gb=round(ram_gb, 2),
            onnx_providers=providers,
            has_accelerator=has_accel,
            recommended_tier=tier,
        )
        logger.info(
            "Hardware probe complete",
            cpus=cpus,
            ram_gb=round(ram_gb, 2),
            has_accelerator=has_accel,
            recommended_tier=tier,
        )
        return profile

    def effective_tier(self, config_tier: str) -> ModelTier:
        """Resolve the user's config tier setting against the probe result.

        ``"auto"`` (default) → uses the probe's recommendation.
        Explicit values are honoured but may produce a warning.
        """
        if config_tier == "auto":
            return self.recommended_tier
        t = config_tier.lower()
        tier: ModelTier
        if t in LEGACY_TIER_ALIASES:
            tier = LEGACY_TIER_ALIASES[t]
        elif t == "off":
            tier = "off"
        elif t == "standard":
            tier = "standard"
        else:
            logger.warning("Unknown ai_model_tier, falling back to probe", value=config_tier)
            return self.recommended_tier
        tier_rank = {"off": 0, "standard": 1}
        if tier_rank[tier] > tier_rank[self.recommended_tier]:
            logger.warning(
                "Requested ai_model_tier may be slow on this machine",
                requested=tier,
                recommended=self.recommended_tier,
                cpus=self.logical_cpus,
                ram_gb=self.total_ram_gb,
            )
        return tier
