#!/bin/sh
cd "$(dirname "$0")"
echo "افتح http://localhost:8000  (Ctrl+C للإيقاف)"
python3 -m http.server 8000
