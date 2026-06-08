"""Benchmark script for GDINO extract_patch_candidates: single and concurrent calls.

Usage:
    python scripts/benchmark.py --url http://localhost:8080 \
                                --video <s3-or-presigned-url> \
                                --concurrency 1 2 4
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests


def run_single(base_url: str, video_path: str, fps: float, tag: str = "") -> dict:
    """Run a single extract_patch_candidates call and return timing data."""
    payload = {
        "video_path": video_path,
        "text_prompt": "person.",
        "fps": fps,
    }
    t0 = time.monotonic()
    resp = requests.post(f"{base_url}/extract_patch_candidates", json=payload, timeout=600)
    wall_time = time.monotonic() - t0

    if resp.status_code != 200:
        return {
            "tag": tag,
            "status": resp.status_code,
            "error": resp.text[:500],
            "wall_time_s": round(wall_time, 3),
        }

    data = resp.json()
    result = {
        "tag": tag,
        "status": 200,
        "wall_time_s": round(wall_time, 3),
        "server_elapsed_s": data.get("elapsed_s"),
        "num_frames": data.get("num_frames_processed"),
        "num_patch_candidates": len(data.get("patch_candidates", [])),
        "num_reference_patches": len(data.get("reference_patches", [])),
    }
    if data.get("profiling"):
        result["profiling"] = data["profiling"]
    return result


def run_concurrent(base_url: str, video_path: str, fps: float, concurrency: int) -> list[dict]:
    """Run N concurrent extract_patch_candidates calls."""
    results = []
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {
            pool.submit(run_single, base_url, video_path, fps, f"req-{i}"): i
            for i in range(concurrency)
        }
        for fut in as_completed(futures):
            results.append(fut.result())
    return results


def print_summary(label: str, results: list[dict]) -> None:
    """Print a summary table for a batch of results."""
    print(f"\n{'='*70}")
    print(f"  {label}")
    print(f"{'='*70}")

    ok = [r for r in results if r["status"] == 200]
    fail = [r for r in results if r["status"] != 200]

    if fail:
        print(f"  FAILURES: {len(fail)}")
        for r in fail:
            print(f"    {r['tag']}: status={r['status']} wall={r['wall_time_s']}s error={r.get('error','')[:100]}")

    if not ok:
        print("  No successful requests.")
        return

    walls = [r["wall_time_s"] for r in ok]
    server_times = [r["server_elapsed_s"] for r in ok]
    fps_vals = [r["num_frames"] / r["server_elapsed_s"] for r in ok if r["server_elapsed_s"] > 0]

    prof0 = ok[0].get("profiling", {})
    print(f"  Requests:   {len(ok)} OK, {len(fail)} failed")
    print(f"  Frames:     {ok[0]['num_frames']}")
    print(f"  Candidates: {ok[0]['num_patch_candidates']} patch candidates, {ok[0]['num_reference_patches']} reference patches")
    print(f"  Batch size: {prof0.get('batch_size', '?')}  gRPC calls: {prof0.get('num_grpc_calls', '?')}")
    print(f"  Wall time:  min={min(walls):.1f}s  max={max(walls):.1f}s  mean={statistics.mean(walls):.1f}s")
    print(f"  Server time: min={min(server_times):.1f}s  max={max(server_times):.1f}s  mean={statistics.mean(server_times):.1f}s")
    if fps_vals:
        print(f"  Throughput: min={min(fps_vals):.1f} fps  max={max(fps_vals):.1f} fps  mean={statistics.mean(fps_vals):.1f} fps")

    # Per-phase profiling breakdown (from first successful result)
    prof = ok[0].get("profiling")
    if prof:
        nf = ok[0]["num_frames"]
        print(f"\n  Per-phase breakdown (first request, {nf} frames):")
        print(f"  {'Phase':<20} {'Total (s)':>10} {'Per-frame (ms)':>15} {'% of server':>12}")
        print(f"  {'-'*20} {'-'*10} {'-'*15} {'-'*12}")
        server_t = ok[0]["server_elapsed_s"]
        for key, label in [
            ("ffmpeg_start_s", "ffmpeg startup"),
            ("gpu_wait_s", "GPU wait"),
            ("gpu_submit_s", "GPU submit"),
            ("io_wait_s", "I/O (read+preproc)"),
            ("tracker_s", "Tracker"),
        ]:
            val = prof.get(key, 0)
            pf = val / max(nf, 1) * 1000
            pct = val / server_t * 100 if server_t > 0 else 0
            print(f"  {label:<20} {val:>10.3f} {pf:>13.1f}ms {pct:>10.1f}%")
        accounted = sum(prof.get(k, 0) for k in ["ffmpeg_start_s", "gpu_wait_s", "gpu_submit_s", "io_wait_s", "tracker_s"])
        unaccounted = server_t - accounted
        print(f"  {'Unaccounted':<20} {unaccounted:>10.3f} {unaccounted/max(nf,1)*1000:>13.1f}ms {unaccounted/server_t*100 if server_t else 0:>10.1f}%")

        # Tracker sub-breakdown
        tracker_t = prof.get("tracker_s", 0)
        if tracker_t > 0:
            print(f"\n  Tracker sub-breakdown ({tracker_t:.1f}s total):")
            print(f"  {'Sub-phase':<20} {'Total (s)':>10} {'Per-frame (ms)':>15} {'% of tracker':>13}")
            print(f"  {'-'*20} {'-'*10} {'-'*15} {'-'*13}")
            for key, label in [
                ("tracker_reid_s", "Re-ID wait"),
                ("tracker_reid_submit_s", "Re-ID submit"),
                ("tracker_crop_s", "Crop extraction"),
                ("tracker_kalman_s", "Kalman predict"),
                ("tracker_match_s", "Matching"),
            ]:
                val = prof.get(key, 0)
                pf = val / max(nf, 1) * 1000
                pct = val / tracker_t * 100 if tracker_t > 0 else 0
                print(f"  {label:<20} {val:>10.3f} {pf:>13.1f}ms {pct:>11.1f}%")
            sub_accounted = sum(prof.get(k, 0) for k in ["tracker_reid_s", "tracker_reid_submit_s", "tracker_crop_s", "tracker_kalman_s", "tracker_match_s"])
            tracker_other = tracker_t - sub_accounted
            print(f"  {'Other':<20} {tracker_other:>10.3f} {tracker_other/max(nf,1)*1000:>13.1f}ms {tracker_other/tracker_t*100 if tracker_t else 0:>11.1f}%")

    # If multiple concurrent results, show profiling for all
    if len(ok) > 1:
        print(f"\n  Concurrent profiling (all {len(ok)} requests):")
        print(f"  {'Req':<8} {'Wall':>7} {'Server':>8} {'GPU wait':>10} {'GPU sub':>9} {'I/O':>9} {'Tracker':>9}")
        for r in sorted(ok, key=lambda x: x["tag"]):
            p = r.get("profiling", {})
            print(f"  {r['tag']:<8} {r['wall_time_s']:>6.1f}s {r['server_elapsed_s']:>7.1f}s "
                  f"{p.get('gpu_wait_s',0):>9.2f}s {p.get('gpu_submit_s',0):>8.3f}s "
                  f"{p.get('io_wait_s',0):>8.2f}s {p.get('tracker_s',0):>8.2f}s")


def main():
    parser = argparse.ArgumentParser(description="Benchmark GDINO extract_patch_candidates")
    parser.add_argument("--url", required=True, help="Base URL of GDINO server")
    parser.add_argument("--video", required=True, help="Video path (S3 URI or presigned URL)")
    parser.add_argument("--fps", type=float, default=5.0, help="Frame extraction rate")
    parser.add_argument("--concurrency", type=int, nargs="+", default=[1, 2, 4],
                        help="Concurrency levels to test (e.g. 1 2 4)")
    parser.add_argument("--json", action="store_true", help="Output raw JSON instead of tables")
    args = parser.parse_args()

    # Health check
    print(f"Checking server health at {args.url}...")
    try:
        r = requests.get(f"{args.url}/health", timeout=10)
        print(f"  Health: {r.json()}")
    except Exception as e:
        print(f"  Health check failed: {e}")
        sys.exit(1)

    all_results = {}
    for c in args.concurrency:
        label = f"Concurrency={c}"
        print(f"\nRunning {label} ...")
        t0 = time.monotonic()
        results = run_concurrent(args.url, args.video, args.fps, c)
        total_wall = time.monotonic() - t0
        all_results[c] = {"results": results, "total_wall_s": round(total_wall, 3)}

        if args.json:
            print(json.dumps(all_results[c], indent=2))
        else:
            print_summary(f"{label}  (total wall={total_wall:.1f}s)", results)

    # Final comparison
    if not args.json and len(args.concurrency) > 1:
        print(f"\n{'='*70}")
        print("  COMPARISON")
        print(f"{'='*70}")
        print(f"  {'Concurrency':>12} {'Total Wall':>12} {'Avg Server':>12} {'Avg FPS':>10} {'Slowdown':>10}")
        baseline = None
        for c in args.concurrency:
            data = all_results[c]
            ok = [r for r in data["results"] if r["status"] == 200]
            if not ok:
                continue
            avg_server = statistics.mean(r["server_elapsed_s"] for r in ok)
            avg_fps = statistics.mean(r["num_frames"] / r["server_elapsed_s"] for r in ok if r["server_elapsed_s"] > 0)
            if baseline is None:
                baseline = avg_server
            slowdown = avg_server / baseline if baseline else 0
            print(f"  {c:>12} {data['total_wall_s']:>11.1f}s {avg_server:>11.1f}s {avg_fps:>9.1f} {slowdown:>9.2f}x")


if __name__ == "__main__":
    main()
