# Shared helpers for the generated deploy-history repo. Source this file; do not run it.
# The repo is separate from the incident-lens repository: it lives in sandbox/.deploy-history (gitignored)
# and every git command here is pinned to it with --git-dir/--work-tree.

DEPLOY_HISTORY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX_DIR="$(dirname "${DEPLOY_HISTORY_LIB_DIR}")"
DEPLOY_HISTORY_ROOT="${SANDBOX_DIR}/.deploy-history"
ORDER_SERVICE_HISTORY="${DEPLOY_HISTORY_ROOT}/order-service"
HISTORY_PATCHES="${DEPLOY_HISTORY_LIB_DIR}/patches"

# Ignore the user's git config (signing, hooks paths, templates) so generation is reproducible.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1
export GIT_CEILING_DIRECTORIES="${DEPLOY_HISTORY_ROOT}"

history_git() {
  git --git-dir="${ORDER_SERVICE_HISTORY}/.git" --work-tree="${ORDER_SERVICE_HISTORY}" "$@"
}

# history_commit "<author name>" "<author email>" "<date spec for date -d>" "<subject>" ["<body>"]
history_commit() {
  local name="$1" email="$2" when="$3" subject="$4" body="${5:-}"
  local stamp
  stamp="$(date -d "${when}" --iso-8601=seconds)"
  history_git add -A
  GIT_AUTHOR_NAME="${name}" GIT_AUTHOR_EMAIL="${email}" GIT_AUTHOR_DATE="${stamp}" \
    GIT_COMMITTER_NAME="${name}" GIT_COMMITTER_EMAIL="${email}" GIT_COMMITTER_DATE="${stamp}" \
    history_git commit -q -m "${subject}" ${body:+-m "${body}"}
}

# history_apply <patch> [-R]: apply a patch to the history work tree, failing loudly if it does not apply.
history_apply() {
  local patch="$1"; shift
  if ! (cd "${ORDER_SERVICE_HISTORY}" && history_git apply "$@" "${patch}"); then
    echo "deploy-history: patch does not apply: ${patch} $*" >&2
    echo "  (has sandbox/services/order-service changed? regenerate the patches)" >&2
    exit 1
  fi
}
