#!/bin/sh
# Builds cpp/usb_transfer for the host with a test device and runs js/ against it.
# Needs a C++17 compiler and Node 20+.
set -e
cd "$(dirname "$0")"
OUT=build
CXX=${CXX:-c++}
FLAGS="-std=c++17 -g -Wall -Wextra -Wno-unused-parameter -Istub -I../cpp ${SANITIZE--fsanitize=address,undefined}"
mkdir -p $OUT

$CXX $FLAGS -o $OUT/harness harness.cpp ../cpp/usb_transfer/*.cpp

echo "# link"
HARNESS=$PWD/$OUT/harness node --test link.test.mjs

echo "# connect"
node --test connect.test.mjs
