#!/usr/bin/env python3
"""Install the optional, CPU-only speaker embedding runtime in an isolated venv."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MODEL_REVISION = 'e4b6ede7ce16997aff4ae69fbca1f0175e2afede'
MODEL_SHA256 = '3388cf5fd3493c9ac9c69851d8e7a8badcfb4f3dc631020c4961371646d5ada8'
CODE_REVISION = '065629c313eaf1a01c65c640c46d77e61e9607b4'
MODEL = {'id': 'funasr/campplus', 'revision': MODEL_REVISION, 'sha256': MODEL_SHA256, 'dimensions': 192, 'sampleRate': 16000, 'license': 'Apache-2.0'}
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--runtime-dir', type=Path, default=Path(os.environ.get('WORKBENCH_VOICEPRINT_RUNTIME', ROOT / 'data' / 'voiceprint-runtime')))
parser.add_argument('--python', default='3.12', help='Python version for uv; default 3.12')
args = parser.parse_args()
runtime = args.runtime_dir.resolve()
runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(runtime, 0o700)
venv = runtime / '.venv'
python = venv / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
uv = shutil.which('uv')
if not python.exists():
    if uv:
        subprocess.run([uv, 'venv', '--python', args.python, str(venv)], check=True)
    elif (3, 10) <= sys.version_info[:2] < (3, 14):
        subprocess.run([sys.executable, '-m', 'venv', str(venv)], check=True)
    else:
        raise SystemExit('Install uv or run this script with Python 3.10–3.13. The existing workbench can still run without voiceprints.')
packages = ['torch==2.7.1', 'torchaudio==2.7.1', 'numpy==2.2.6']
print('Installing isolated CPU dependencies; model weights are 28 MB.', flush=True)
if uv:
    subprocess.run([uv, 'pip', 'install', '--python', str(python), *packages], check=True)
else:
    subprocess.run([str(python), '-m', 'pip', 'install', *packages], check=True)

def download(url, target, expected_sha=None):
    if target.exists() and (not expected_sha or hashlib.sha256(target.read_bytes()).hexdigest() == expected_sha):
        return
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    print(f'Downloading {target.name}', flush=True)
    with urllib.request.urlopen(url, timeout=120) as response:
        payload = response.read()
    if expected_sha and hashlib.sha256(payload).hexdigest() != expected_sha:
        raise RuntimeError(f'Checksum mismatch: {target.name}')
    target.write_bytes(payload)
    os.chmod(target, 0o600)

download(f'https://huggingface.co/funasr/campplus/resolve/{MODEL_REVISION}/campplus_cn_common.bin', runtime / 'campplus_cn_common.bin', MODEL_SHA256)
for relative in ['speakerlab/models/campplus/DTDNN.py', 'speakerlab/models/campplus/layers.py', 'LICENSE']:
    download(f'https://raw.githubusercontent.com/modelscope/3D-Speaker/{CODE_REVISION}/{relative}', runtime / 'vendor' / relative)
download(f'https://huggingface.co/funasr/campplus/resolve/{MODEL_REVISION}/README.md', runtime / 'MODEL_CARD.md')
# Verification uses public vendor examples only, never a local meeting recording.
public_samples = []
for name in ['speaker1_a_cn_16k.wav', 'speaker1_b_cn_16k.wav', 'speaker2_a_cn_16k.wav']:
    target = runtime / 'public-test-audio' / name
    download('https://modelscope.cn/api/v1/models/iic/speech_campplus_sv_zh-cn_16k-common/repo?Revision=v1.0.0&FilePath=examples/' + name, target)
    public_samples.append(str(target))
result = subprocess.run([str(python), str(ROOT / 'server' / 'voiceprints' / 'worker.py'), '--runtime-dir', str(runtime)], input=json.dumps({'paths': public_samples}), text=True, capture_output=True, timeout=120, check=True)
vectors = json.loads(result.stdout)['embeddings']
assert len(vectors) == 3 and all(len(vector) == 192 for vector in vectors)
verification = {'publicSameSpeakerCosine': sum(a*b for a, b in zip(vectors[0], vectors[1])), 'publicDifferentSpeakerCosine': sum(a*b for a, b in zip(vectors[0], vectors[2])), 'note': 'Public example smoke test only; not a meeting accuracy benchmark or calibrated identity threshold.'}
manifest = {'model': MODEL, 'codeRepository': 'modelscope/3D-Speaker', 'codeRevision': CODE_REVISION, 'packages': packages, 'device': 'cpu', 'verifiedAt': datetime.now(timezone.utc).isoformat(), 'verification': verification}
(runtime / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
os.chmod(runtime / 'manifest.json', 0o600)
print(json.dumps({'ready': True, 'runtimeDir': str(runtime), 'model': MODEL, 'verification': verification}, ensure_ascii=False))
