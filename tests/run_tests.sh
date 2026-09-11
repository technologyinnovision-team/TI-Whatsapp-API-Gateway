#!/usr/bin/env bash
set -e

echo "=== [1/3] Running WhatsApp Anti-Ban & Spintax JS Tests ==="
cd wa-bridge
node ../tests/test_safety.js
cd ..

echo ""
echo "=== [2/3] Running WhatsApp Interactive Button Replies Tests ==="
node tests/test_button_reply.js

echo ""
echo "=== [3/3] Running Python Gateway & REST API Tests ==="
flask-app/venv/bin/python3 tests/test_platform.py

echo ""
echo "✅ ALL PLATFORM TESTS PASSED SUCCESSFULLY!"
