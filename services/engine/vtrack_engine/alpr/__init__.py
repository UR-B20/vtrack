"""The ALPR adapters (CLAUDE.md §5.4). `build_alpr` is the only switch: ALPR_ENGINE=local|cloud."""

from ..config import Settings
from .base import ALPR, ALPRError, PlateBand, PlateRead, Selection, select

__all__ = ["ALPR", "ALPRError", "PlateBand", "PlateRead", "Selection", "build_alpr", "select"]


def build_alpr(settings: Settings) -> ALPR:
    if settings.alpr_engine == "cloud":
        from .cloud_platerecognizer import CloudPlateRecognizer
        return CloudPlateRecognizer(settings.platerecognizer_token)
    from .local_fastalpr import LocalFastALPR
    return LocalFastALPR(threads=settings.alpr_threads, offline=settings.alpr_offline,
                         detector_conf=settings.alpr_detector_conf)
