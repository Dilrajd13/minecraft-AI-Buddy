"""Push-to-talk ears for the Minecraft buddy.

Hold the push-to-talk key, talk, let go. NVIDIA Parakeet-TDT-0.6B-v2 (int8 ONNX build, runs on the
CPU so your 6 GB GPU stays free for Minecraft) turns it into text and sends it to the bot.

    python stt/ears.py --model-dir W:/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8 --key f8
"""
import argparse
import json
import os
import sys
import threading
import time
import urllib.request

import keyboard
import numpy as np
import sherpa_onnx
import sounddevice as sd

RATE = 16000


def load_recognizer(model_dir: str, threads: int):
    def f(name):
        p = os.path.join(model_dir, name)
        if not os.path.exists(p):
            sys.exit(f"missing {p} - download the Parakeet model first (see README)")
        return p

    return sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=f("encoder.int8.onnx"),
        decoder=f("decoder.int8.onnx"),
        joiner=f("joiner.int8.onnx"),
        tokens=f("tokens.txt"),
        num_threads=threads,
        model_type="nemo_transducer",
    )


def send(url: str, text: str):
    req = urllib.request.Request(url, data=json.dumps({"text": text}).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=3).close()
    except Exception as e:  # bot not running yet, etc.
        print(f"  (couldn't reach the bot at {url}: {e})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--key", default="f8", help="push-to-talk key (e.g. f8, caps lock, v, right ctrl)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("EARS_PORT", 3077)))
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--device", default=None, help="mic device index or name (python -m sounddevice lists them)")
    args = ap.parse_args()

    url = f"http://127.0.0.1:{args.port}/heard"
    print("loading Parakeet...")
    rec = load_recognizer(args.model_dir, args.threads)

    chunks = []
    lock = threading.Lock()
    recording = False

    def on_audio(indata, frames, t, status):
        if recording:
            with lock:
                chunks.append(indata[:, 0].copy())

    device = int(args.device) if args.device and args.device.isdigit() else args.device
    with sd.InputStream(samplerate=RATE, channels=1, dtype="float32", callback=on_audio, device=device):
        print(f"ready - hold [{args.key}] and talk. Ctrl+C to quit.")
        while True:
            keyboard.wait(args.key)  # blocks until pressed
            with lock:
                chunks.clear()
            recording = True
            print("  listening...", end="", flush=True)
            while keyboard.is_pressed(args.key):
                time.sleep(0.02)
            time.sleep(0.15)  # catch the tail of the last word
            recording = False
            with lock:
                audio = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
            if len(audio) < RATE * 0.3:
                print(" (too short)")
                continue
            t0 = time.time()
            s = rec.create_stream()
            s.accept_waveform(RATE, audio)
            rec.decode_stream(s)
            text = s.result.text.strip()
            print(f" \"{text}\" ({time.time() - t0:.2f}s)")
            if text:
                send(url, text)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
