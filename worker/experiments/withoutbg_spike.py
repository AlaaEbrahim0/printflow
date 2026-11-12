"""Offline withoutbg spike. Run inside Compose worker with PYTHONPATH for installed package."""
from __future__ import annotations
import argparse, json, os, resource, time
from pathlib import Path
from PIL import Image
from withoutbg import WithoutBG

MODEL = Path(os.environ.get('WITHOUTBG_MODEL_PATH', '/data/storage/models/withoutbg/withoutbg-open-weights.onnx'))

def run(model, path: Path) -> dict:
    started = time.perf_counter()
    image = Image.open(path)
    result = model.remove_background(image)
    elapsed = time.perf_counter() - started
    alpha = result.getchannel('A') if result.mode == 'RGBA' else None
    return {
        'path': str(path), 'inputSize': image.size, 'outputSize': result.size,
        'inputMode': image.mode, 'outputMode': result.mode, 'seconds': round(elapsed, 3),
        'alphaMin': alpha.getextrema()[0] if alpha else None,
        'alphaMax': alpha.getextrema()[1] if alpha else None,
        'alphaPartialPixels': sum(1 for value in alpha.getdata() if 0 < value < 255) if alpha else None,
        'rssBytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
    }

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('images', nargs='+', type=Path)
    parser.add_argument('--output', type=Path, default=Path('/tmp/withoutbg-spike-results.json'))
    args = parser.parse_args()
    model = WithoutBG.open_weights(MODEL)
    model.preload()
    results = [run(model, path) for path in args.images]
    args.output.write_text(json.dumps({'package': 'withoutbg 1.5.0', 'model': str(MODEL), 'results': results}, indent=2))
    print(json.dumps(results, indent=2))

if __name__ == '__main__':
    main()
