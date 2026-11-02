"""Collect the extension modules present in the locked SciPy wheel.

PyInstaller 6.21's hook assumes every SciPy >=1.13 has _cdflib, but later
wheels no longer ship that extension. Preserve the real hidden imports
without asking the freezer for an extension that no longer exists.
"""

from PyInstaller.utils.hooks import can_import_module

hiddenimports = [
    module
    for module in (
        "scipy.special._ufuncs_cxx",
        "scipy.special._cdflib",
        "scipy.special._special_ufuncs",
    )
    if can_import_module(module)
]
