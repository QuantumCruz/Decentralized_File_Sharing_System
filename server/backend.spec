# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['server_persistent.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=['aiohttp', 'stem', 'stem.control', 'cryptography', 'cryptography.hazmat.primitives.asymmetric.padding', 'cryptography.hazmat.primitives.ciphers.algorithms', 'cryptography.hazmat.primitives.ciphers.modes', 'aiohttp_sse', 'pkg_resources.extern'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['PyQt5', 'numpy', 'PIL', 'matplotlib', 'tkinter', 'scipy'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
