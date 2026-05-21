#!/usr/bin/env bash
# portless 経由で dashboard を起動する → https://workflow.localhost
# proxy が未起動なら portless が自動起動する
exec bunx portless workflow bash "$(dirname "$0")/start.sh"
