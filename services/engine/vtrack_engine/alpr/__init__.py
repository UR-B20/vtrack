"""The ALPR adapters (CLAUDE.md §5.4). `build_alpr` is the only switch: ALPR_ENGINE=local|cloud."""

from ..config import Settings
from .base import ALPR, ALPRError, PlateRead, pick

__all__ = ["ALPR", "ALPRError", "PlateRead", "build_alpr", "pick"]


def build_alpr(settings: Settings) -> ALPR:
    if settings.alpr_engine == "cloud":
        from .cloud_platerecognizer import CloudPlateRecognizer
        return CloudPlateRecognizer(settings.platerecognizer_token)
    from .local_fastalpr import LocalFastALPR
    return LocalFastALPR()
