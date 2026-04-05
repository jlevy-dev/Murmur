"""Build script to package the Python ML backend as a standalone exe."""
import PyInstaller.__main__
import os

here = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------------------
# Modules to exclude – these are not needed for inference and bloat the build
# ---------------------------------------------------------------------------
exclude_modules = [
    # PyTorch components not needed for inference
    'torch.distributed',
    'torch.testing',
    'torch._inductor',
    'torch._dynamo',
    'torch._functorch',
    'torch.ao',                # quantization-aware training utilities
    'torch.utils.tensorboard',
    'caffe2',

    # Python stdlib / third-party packages never used at runtime
    'tkinter',
    'matplotlib',
    'IPython',
    'jupyter',
    'jupyter_client',
    'jupyter_core',
    'nbconvert',
    'nbformat',
    'notebook',
    'pytest',
    'setuptools',
    'pip',
    'wheel',
    'distutils',
    'unittest',
    'pydoc',
    'doctest',
]

exclude_flags = []
for mod in exclude_modules:
    exclude_flags.extend(['--exclude-module', mod])

# ---------------------------------------------------------------------------
# Rather than --collect-all for large packages (which pulls in tests,
# examples, and optional extras), only collect their *data* files.
# --collect-data grabs package-data / resource files without pulling every
# sub-module.  Hidden-imports below already ensure the required code modules
# are included.
# ---------------------------------------------------------------------------

PyInstaller.__main__.run([
    os.path.join(here, 'server.py'),
    '--name=murmur-backend',
    '--onedir',
    '--console',
    '--noconfirm',
    '--clean',
    # Hidden imports that PyInstaller misses
    '--hidden-import=faster_whisper',
    '--hidden-import=ctranslate2',
    '--hidden-import=speechbrain',
    '--hidden-import=speechbrain.inference',
    '--hidden-import=speechbrain.inference.speaker',
    '--hidden-import=transformers',
    '--hidden-import=torch',
    '--hidden-import=torchaudio',
    '--hidden-import=numpy',
    '--hidden-import=scipy',
    '--hidden-import=scipy.cluster',
    '--hidden-import=scipy.cluster.hierarchy',
    '--hidden-import=scipy.spatial',
    '--hidden-import=scipy.spatial.distance',
    '--hidden-import=websockets',
    '--hidden-import=websockets.asyncio',
    '--hidden-import=websockets.asyncio.server',
    '--hidden-import=accelerate',
    '--hidden-import=huggingface_hub',
    '--hidden-import=tokenizers',
    '--hidden-import=sentencepiece',
    '--hidden-import=soundfile',
    '--hidden-import=av',
    # Collect only data/resource files (not every sub-module) for large pkgs.
    # faster_whisper & ctranslate2 are small – keep --collect-all for them.
    '--collect-all=faster_whisper',
    '--collect-all=ctranslate2',
    '--collect-data=speechbrain',
    '--collect-data=transformers',
    '--collect-data=tokenizers',
    *exclude_flags,
    f'--distpath={os.path.join(here, "..", "python-dist")}',
    f'--workpath={os.path.join(here, "build")}',
    f'--specpath={here}',
])
