"""One CPU process per queued task; audio and features never leave this machine."""
import argparse
import json
import os
from pathlib import Path
import sys
import wave

parser = argparse.ArgumentParser()
parser.add_argument('--runtime-dir', required=True)
args = parser.parse_args()
runtime_dir = Path(args.runtime_dir)
sys.path.insert(0, str(runtime_dir / 'vendor'))
os.environ.setdefault('OMP_NUM_THREADS', '2')

import numpy as np
import torch
import torchaudio.compliance.kaldi as kaldi
from speakerlab.models.campplus.DTDNN import CAMPPlus

torch.set_num_threads(2)
torch.set_num_interop_threads(1)
model = CAMPPlus(feat_dim=80, embedding_size=192)
model.load_state_dict(torch.load(runtime_dir / 'campplus_cn_common.bin', map_location='cpu', weights_only=True))
model.eval()
request = json.load(sys.stdin)
embeddings = []
for filename in request['paths']:
    if str(filename).lower().endswith('.wav'):
        with wave.open(str(filename), 'rb') as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 16000):
                raise ValueError('Expected mono 16 kHz 16-bit PCM WAV')
            raw = wav.readframes(wav.getnframes())
    else:
        raw = Path(filename).read_bytes()
    pcm = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    if len(pcm) < 3 * 16000 or len(pcm) > 30 * 16000:
        raise ValueError('Expected a single-speaker segment between 3 and 30 seconds')
    if not np.isfinite(pcm).all() or np.sqrt(np.mean(pcm * pcm)) < 0.001:
        raise ValueError('Audio is silent or too quiet for enrollment')
    if np.mean(np.abs(pcm) >= 0.999) > 0.05:
        raise ValueError('Audio is heavily clipped')
    waveform = torch.from_numpy(pcm).unsqueeze(0)
    # Same FBank settings and mean normalization as official 3D-Speaker FBank.
    features = kaldi.fbank(waveform, num_mel_bins=80, sample_frequency=16000, dither=0)
    features = features - features.mean(0, keepdim=True)
    with torch.inference_mode():
        embedding = model(features.unsqueeze(0)).squeeze(0)
    if embedding.shape != (192,) or not torch.isfinite(embedding).all():
        raise ValueError('Invalid speaker embedding')
    embedding = torch.nn.functional.normalize(embedding, dim=0)
    embeddings.append(embedding.tolist())
print(json.dumps({'embeddings': embeddings, 'dimensions': 192}, allow_nan=False))
