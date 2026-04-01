"""Build script to package the Python ML backend as a standalone exe."""
import PyInstaller.__main__
import os

here = os.path.dirname(os.path.abspath(__file__))

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
    # Collect all data files for these packages
    '--collect-all=faster_whisper',
    '--collect-all=ctranslate2',
    '--collect-all=speechbrain',
    '--collect-all=transformers',
    '--collect-all=tokenizers',
    f'--distpath={os.path.join(here, "..", "python-dist")}',
    f'--workpath={os.path.join(here, "build")}',
    f'--specpath={here}',
])
