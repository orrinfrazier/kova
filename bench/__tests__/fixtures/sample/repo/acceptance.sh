#!/bin/sh
# Acceptance: pass iff SOLVED.txt exists at the repo root.
if [ -f SOLVED.txt ]; then
  echo "PASS"
  exit 0
fi
echo "FAIL: SOLVED.txt not found"
exit 1
