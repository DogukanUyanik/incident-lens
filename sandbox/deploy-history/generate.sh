#!/usr/bin/env bash
# Generate the clean deploy history of order-service: a small standalone git repo whose last commit is exactly
# the current sandbox/services/order-service source. Earlier commits are reconstructed by reverse-applying the
# patches in patches/ (newest first), then committed forward one by one.
#
# A previous repo is moved aside to .deploy-history/.previous/ (never deleted); remove that folder when you like.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SOURCE_DIR="${SANDBOX_DIR}/services/order-service"

# Ordered history: patch file | author | email | age | subject. The initial commit precedes the first patch.
INITIAL=("Marta Kowalski" "marta.kowalski@shop.example" "-6 days -3 hours -12 minutes" "Initial order-service")
HISTORY=(
  "02-health-endpoint.patch|Marta Kowalski|marta.kowalski@shop.example|-5 days -1 hours -40 minutes|Add health endpoint with pool stats"
  "03-validate-quantities.patch|Daniel Osei|daniel.osei@shop.example|-3 days -5 hours -3 minutes|Validate line item quantities"
  "04-idempotency-key.patch|Priya Raman|priya.raman@shop.example|-2 days -2 hours -27 minutes|Support Idempotency-Key on order creation"
  "05-alpine-base-image.patch|Daniel Osei|daniel.osei@shop.example|-1 days -2 hours -9 minutes|Use alpine base image"
  "06-readme.patch|Marta Kowalski|marta.kowalski@shop.example|-5 hours -18 minutes|Add README with local dev steps"
)

mkdir -p "${DEPLOY_HISTORY_ROOT}"
if [ -e "${ORDER_SERVICE_HISTORY}" ]; then
  mkdir -p "${DEPLOY_HISTORY_ROOT}/.previous"
  mv "${ORDER_SERVICE_HISTORY}" "${DEPLOY_HISTORY_ROOT}/.previous/order-service-$(date +%Y%m%dT%H%M%S)-$$"
fi
mkdir -p "${ORDER_SERVICE_HISTORY}"

# Start from the current source, then walk back to the initial tree.
tar -C "${SOURCE_DIR}" --exclude=node_modules -cf - . | tar -C "${ORDER_SERVICE_HISTORY}" -xf -
git init -q -b main "${ORDER_SERVICE_HISTORY}"
for ((i = ${#HISTORY[@]} - 1; i >= 0; i--)); do
  IFS='|' read -r patch _ _ _ _ <<<"${HISTORY[$i]}"
  history_apply "${HISTORY_PATCHES}/${patch}" -R
done

history_commit "${INITIAL[@]}"
for entry in "${HISTORY[@]}"; do
  IFS='|' read -r patch name email when subject <<<"${entry}"
  history_apply "${HISTORY_PATCHES}/${patch}"
  history_commit "${name}" "${email}" "${when}" "${subject}"
done

# The generated history must end exactly at the deployed source.
if ! diff -r -q -x .git -x node_modules "${SOURCE_DIR}" "${ORDER_SERVICE_HISTORY}" >/dev/null; then
  echo "deploy-history: generated tree differs from ${SOURCE_DIR}" >&2
  diff -r -q -x .git -x node_modules "${SOURCE_DIR}" "${ORDER_SERVICE_HISTORY}" >&2 || true
  exit 1
fi
echo "deploy-history: generated ${ORDER_SERVICE_HISTORY} ($(history_git rev-list --count HEAD) commits)"
