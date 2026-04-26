"""Build script to package the Python ML backend as a standalone exe."""
import PyInstaller.__main__
import os

here = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------------------
# Modules to exclude – these are not needed for inference and bloat the build
# ---------------------------------------------------------------------------
exclude_modules = [
    # NOTE: torch internals are too interconnected to safely exclude.
    # Only exclude things that are definitely standalone.
    'torch.utils.tensorboard',
    'caffe2',

    # Python stdlib / third-party packages never used at runtime
    # NOTE: keep stdlib modules (unittest, pydoc, doctest) — many libs import them
    'tkinter',
    'matplotlib',
    'IPython',
    'jupyter',
    'jupyter_client',
    'jupyter_core',
    'nbconvert',
    'nbformat',
    'notebook',
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
    '--hidden-import=nemo.collections.asr',
    '--hidden-import=nemo.collections.asr.models',
    '--hidden-import=nemo.core',
    '--hidden-import=nemo.utils',
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
    '--hidden-import=langdetect',
    '--hidden-import=omegaconf',
    '--hidden-import=hydra',
    '--hidden-import=pytorch_lightning',
    # pkg_resources sub-modules (PyInstaller misses these vendored deps)
    '--hidden-import=jaraco.text',
    '--hidden-import=jaraco.functools',
    '--hidden-import=jaraco.context',
    '--hidden-import=jaraco.collections',
    '--hidden-import=jaraco.classes',
    '--hidden-import=more_itertools',
    '--hidden-import=pkg_resources.extern',
    '--hidden-import=pkg_resources._vendor',
    '--collect-submodules=pkg_resources',
    # Collect data/resource files for NeMo and its dependencies
    '--collect-data=nemo',
    '--collect-data=nemo_toolkit',
    '--collect-data=speechbrain',
    '--collect-data=transformers',
    '--collect-data=tokenizers',
    '--collect-data=langdetect',
    '--collect-data=omegaconf',
    '--collect-data=hydra',
    *exclude_flags,
    f'--distpath={os.path.join(here, "..", "python-dist")}',
    f'--workpath={os.path.join(here, "build")}',
    f'--specpath={here}',
])
