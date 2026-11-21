#!/usr/bin/env bash
# Run before every push: no secrets, no private names. Exits non-zero on any hit.
#   .public-denylist  one private term per line (git-ignored, kept only on the maintainer's machine)
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
if [ -f .public-denylist ]; then
  if git ls-files -co --exclude-standard -z | xargs -0 grep -niIF -f .public-denylist -- 2>/dev/null; then
    echo "check-public: private terms found (above)"; fail=1
  fi
else
  echo "check-public: no .public-denylist here, skipping the private-names check"
fi
# Project rule: every .md filename is in capitals (README.md, SKILL.md, LARAVEL.md).
if git ls-files -co --exclude-standard '*.md' | grep -vE '(^|/)[A-Z0-9_-]+\.md$'; then
  echo "check-public: .md filenames above must be in capitals"; fail=1
fi
if command -v gitleaks >/dev/null; then
  gitleaks detect --no-banner --redact -v || fail=1
  gitleaks detect --no-banner --redact -v --no-git --source . || fail=1
else
  echo "check-public: gitleaks not installed (brew install gitleaks); CI runs it on every PR"
fi
exit $fail
