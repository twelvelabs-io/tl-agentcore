#!/usr/bin/env bash
# Monitor GDINO server resource utilization at 1-second intervals.
#
# Usage:
#   ./monitor.sh              # 60 seconds (default)
#   ./monitor.sh 120          # 120 seconds
#   ./monitor.sh 30 2         # 30 seconds, 2-second interval
#
# Environment:
#   NAMESPACE   K8s namespace (default: tl-vcs)
#   LABEL       Pod label selector (default: app.kubernetes.io/name=expert-gdino)
set -euo pipefail

DURATION="${1:-60}"
INTERVAL="${2:-1}"
NAMESPACE="${NAMESPACE:-tl-vcs}"
LABEL="${LABEL:-app.kubernetes.io/name=expert-gdino}"

POD=$(kubectl get pods -n "$NAMESPACE" -l "$LABEL" -o jsonpath='{.items[0].metadata.name}')
echo "Pod: $POD  |  Duration: ${DURATION}s  |  Interval: ${INTERVAL}s"
echo ""
printf "%-9s %5s %7s %5s %8s %8s %7s %8s %7s %3s\n" \
    "Time" "GPU%" "Power" "Temp" "GPU-Mem" "GPU-Tot" "CPU%" "RAM-MB" "RAM%" "ff"
printf "%-9s %5s %7s %5s %8s %8s %7s %8s %7s %3s\n" \
    "--------" "----" "------" "----" "-------" "-------" "----" "------" "----" "--"

END=$((SECONDS + DURATION))
while [ $SECONDS -lt $END ]; do
    kubectl exec -n "$NAMESPACE" "$POD" -- bash -c '
        gpu=$(nvidia-smi --query-gpu=utilization.gpu,power.draw,temperature.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null)
        ff=$(ps aux --no-headers 2>/dev/null | grep -c "[f]fmpeg" || true)
        # Per-process CPU + RSS memory
        ps aux --no-headers 2>/dev/null | awk "{cpu+=\$3; rss+=\$6} END{printf \"%.0f|%.0f\",cpu,rss/1024}"
        echo "|$ff|$gpu"
    ' 2>/dev/null | awk -F'[,|]' -v t="$(date +%H:%M:%S)" '{
        # $1=cpu%, $2=ram_mb, $3=ffmpeg, $4=gpu%, $5=power, $6=temp, $7=gpu_mem_used, $8=gpu_mem_total
        gsub(/ /,"",$4); gsub(/ /,"",$5); gsub(/ /,"",$6); gsub(/ /,"",$7); gsub(/ /,"",$8)
        ram_pct = ($8+0 > 0) ? "" : ""
        # Compute GPU memory utilization %
        gpu_mem_pct = ($8+0 > 0) ? sprintf("%.0f", $7/$8*100) : "?"
        printf "%-9s %4s%% %6sW %4s°C %6sMiB %6sMiB %6s%% %6sMB %5s%% %3s\n", \
            t, $4, $5, $6, $7, $8, $1, $2, gpu_mem_pct, $3
    }'
    sleep "$INTERVAL"
done

echo ""
echo "Done. Columns: GPU%=utilization, Power=watts, Temp=celsius, GPU-Mem=used/total VRAM,"
echo "  CPU%=all processes, RAM-MB=RSS total, RAM%=GPU memory utilization, ff=ffmpeg count"
