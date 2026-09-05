#!/usr/bin/env bash
# The Runta OCI wrapper can leave its injected init alive during Pier verifier builds.
# Only replace the known wrapper symlink; never overwrite a packaged binary.
set -euo pipefail
wrapper=/usr/local/sbin/runc
target=$(readlink "$wrapper" || true)
if [ "$target" = /opt/runta/runta-runc ]; then
  test -x /usr/bin/runc
  /usr/bin/runc --version
  ln -sfn /usr/bin/runc "$wrapper"
  echo "Restored $wrapper -> /usr/bin/runc"
fi
mkdir -p /work/evidence
command -v runc > /work/evidence/runc-path.txt
runc --version > /work/evidence/runc-version.txt
