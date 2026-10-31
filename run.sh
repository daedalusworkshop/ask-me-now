#!/usr/bin/env bash
# Listening Lab — one command to set up and run.
#   ./run.sh                        start the app (first run installs what it needs)
#   ./run.sh --install-transcriber  also install Transkun (falls back to Basic Pitch)
#   ./run.sh --selftest             print the test-mode report in the terminal
set -e
cd "$(dirname "$0")"

PY=$(command -v python3 || true)
if [ -z "$PY" ]; then
  echo "Python 3 is needed. Install it from https://www.python.org/downloads/ and run ./run.sh again."
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  echo "First run: creating a private Python environment in .venv …"
  "$PY" -m venv .venv
fi
VPY=.venv/bin/python

# Install / update the core packages only when requirements.txt changes
STAMP=.venv/.req-stamp
if [ ! -f "$STAMP" ] || ! cmp -s requirements.txt "$STAMP"; then
  echo "Installing core packages (numpy, mido, ffmpeg) …"
  "$VPY" -m pip install --quiet --upgrade pip
  "$VPY" -m pip install --quiet -r requirements.txt
  cp requirements.txt "$STAMP"
fi

if [ "$1" = "--install-transcriber" ]; then
  echo "Installing Transkun (downloads PyTorch; can take a while) …"
  # Transkun still imports pkg_resources, which newer setuptools removed
  # and Python 3.13+ needs audioop-lts for pydub, which Transkun uses to read audio
  if "$VPY" -m pip install transkun "setuptools<81" "audioop-lts; python_version>='3.13'"; then
    echo "Transkun installed."
  else
    echo "Transkun failed to install — trying Spotify's Basic Pitch instead …"
    "$VPY" -m pip install basic-pitch && echo "Basic Pitch installed (fallback)."
  fi
  shift
fi

if [ "$1" = "--selftest" ]; then
  exec "$VPY" -m listening_lab.selftest
fi

exec "$VPY" lab.py "$@"
