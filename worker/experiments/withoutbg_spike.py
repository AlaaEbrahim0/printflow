"""withoutbg offline spike. Run inside Compose worker; never production path."""
from __future__ import annotations
import argparse, json, os, resource, time
from pathlib import Path
from PIL import Image
from withoutbg import WithoutBG
from withoutbg.routed import fit_max_size

MODEL = Path(os.environ.get('WITHOUTBG_MODEL_PATH', '/data/storage/models/withoutbg/withoutbg-open-weights.onnx'))

def run(model, path: Path) -> dict:
    image = Image.open(path).convert('RGB')
    route = 'unavailable'
    started = time.perf_counter()
    routed = getattr(getattr(model, 'model', None), 'routed', None)
    if routed is not None:
        work = fit_max_size(image, *routed.max_size)
        import numpy as np
        rgb = np.asarray(work, dtype=np.float32) / 255.0
        route, _, _ = routed._route(rgb)
    route_at = time.perf_counter()
    print(json.dumps({'event': 'route', 'image': str(path), 'category': route, 'timestamp': time.time()}), flush=True)
    result = model.remove_background(image)
    elapsed = time.perf_counter() - started
    alpha = result.getchannel('A') if result.mode == 'RGBA' else None
    output = {'path': str(path), 'inputSize': image.size, 'outputSize': result.size, 'inputMode': image.mode, 'outputMode': result.mode, 'routeCategory': route, 'routeSeconds': round(route_at - started, 3), 'inferenceSeconds': round(elapsed, 3), 'alphaMin': alpha.getextrema()[0] if alpha else None, 'alphaMax': alpha.getextrema()[1] if alpha else None, 'alphaPartialPixels': sum(1 for value in alpha.getdata() if 0 < value < 255) if alpha else None, 'rssBytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024}
    print(json.dumps(output), flush=True)
    return output

def main() -> None:
    parser = argparse.ArgumentParser(); parser.add_argument('images', nargs='+', type=Path); parser.add_argument('--output', type=Path, default=Path('/tmp/withoutbg-spike-results.json')); args = parser.parse_args()
    started = time.perf_counter(); model = WithoutBG.open_weights(MODEL); model.preload(); preload = time.perf_counter() - started
    results = [run(model, path) for path in args.images]
    args.output.write_text(json.dumps({'package': 'withoutbg 1.5.0', 'pinnedRevision': 'd0bfe3f4d0cefe0a2ad427f350c6373a7e889ea0', 'python': '3.12', 'runtime': 'Compose worker CPU-only', 'model': str(MODEL), 'preloadSeconds': round(preload, 3), 'results': results}, indent=2))

if __name__ == '__main__': main()
