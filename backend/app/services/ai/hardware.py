"""Hardware capability probe for AI model tier selection.

Detects CPU cores, RAM, and available ONNX execution providers once at startup,
then recommends a model tier so the app auto-disables or downgrades AI on weak
machines rather than hanging or OOM-ing.

Tier definitions:
  off      — machine is below the minimum (< 4 CPUs or < 3.5 GB RAM)
  lite     — CLIP ViT-B/32 via fastembed (light, already bundled)
  standard — SigLIP 2 base/16 via onnxruntime (default on capable hardware)
  max      — SigLIP 2 large/16 (for machines with an accelerator EP)
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Literal

from app.core.logging_config import get_logger

logger = get_logger(__name__)

ModelTier = Literal["off", "lite", "standard", "max"]

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

            out = subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True)
            return int(out.strip()) / (1024**3)
        if platform.system() == "Windows":
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
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))  # type: ignore[attr-defined]
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
    if cpus < 4 or ram_gb < 3.5:
        return "off"
    if has_accel:
        return "max"
    if cpus >= 8 or ram_gb >= 7.5:
        return "standard"
    return "lite"


@dataclass(frozen=True)
class HardwareProfile:
    """Immutable snapshot of the machine's AI-relevant hardware."""

    logical_cpus: int
    total_ram_gb: float
    onnx_providers: list[str] = field(default_factory=list)
    has_accelerator: bool = False
    recommended_tier: ModelTier = "lite"

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
        valid: tuple[ModelTier, ...] = ("off", "lite", "standard", "max")
        if t not in valid:
            logger.warning("Unknown ai_model_tier, falling back to probe", value=config_tier)
            return self.recommended_tier
        tier: ModelTier = t
        tier_rank = {"off": 0, "lite": 1, "standard": 2, "max": 3}
        if tier_rank.get(tier, 0) > tier_rank.get(self.recommended_tier, 0):
            logger.warning(
                "Requested ai_model_tier may be slow on this machine",
                requested=tier,
                recommended=self.recommended_tier,
                cpus=self.logical_cpus,
                ram_gb=self.total_ram_gb,
            )
        return tier
