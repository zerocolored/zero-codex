#!/bin/bash
# Deny-by-default ZEROKUN_PGREP_BIN shim for tests.
#
# Always reports "nothing matched" (pgrep exit 1) so a test run never scans the
# machine and can never select a live production Claude bridge. A test that
# needs candidates writes its own shim printing the PIDs it spawned and points
# ZEROKUN_PGREP_BIN at that file.
exit 1
