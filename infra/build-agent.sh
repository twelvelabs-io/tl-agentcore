#!/usr/bin/env bash
# Build + push the Strands agent container to ECR. Idempotent.
#
# The first run requires `terraform apply` to have created the ECR repo
# already (so the URI exists). Subsequent runs just push :latest.

set -euo pipefail
cd "$(dirname "$0")"

AWS_PROFILE=${AWS_PROFILE:-default}
AWS_REGION=${AWS_REGION:-us-east-1}
export AWS_PROFILE AWS_REGION

REPO_URL=$(terraform output -raw agent_ecr_url 2>/dev/null || true)
if [ -z "${REPO_URL}" ]; then
  echo "ERROR: agent_ecr_url not in terraform output yet — run 'terraform apply' first."
  exit 1
fi
ACCOUNT=$(echo "${REPO_URL}" | cut -d. -f1)

echo "==> 1/4 docker login to ECR"
aws ecr get-login-password --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin "${ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com"

TAG="v$(date +%Y%m%d%H%M%S)"

echo "==> 2/4 build linux/arm64 image (AgentCore Runtime is Graviton)"
docker buildx build \
  --platform linux/arm64 \
  -t "${REPO_URL}:${TAG}" \
  -t "${REPO_URL}:latest" \
  --load \
  ../agent

echo "==> 3/4 push :${TAG} and :latest"
docker push "${REPO_URL}:${TAG}"
docker push "${REPO_URL}:latest"

echo "==> 4/4 done"
echo "    ${REPO_URL}:${TAG}"
echo
echo "Now bump the runtime to this image:"
echo "    terraform apply -var agent_image_tag=${TAG}"
