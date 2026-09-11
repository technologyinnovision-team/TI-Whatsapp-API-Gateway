#!/usr/bin/env bash
set -e

echo "=== [1/2] Running WhatsApp Anti-Ban & Spintax JS Tests ==="
cd wa-bridge
node ../tests/test_safety.js
cd ..

echo ""
echo "=== [2/2] Running Python Gateway & REST API Tests ==="
flask-app/venv/bin/python3 tests/test_platform.py

echo ""
echo "✅ ALL PLATFORM TESTS PASSED SUCCESSFULLY!"
