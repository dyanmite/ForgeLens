#!/usr/bin/env bash
# Start TrueForge in local mode for ForgeLens.
#
# TrueForge's SSRF guard blocks MCP servers on private addresses by default.
# ForgeLens' editor MCP server listens on 127.0.0.1 only, so we allow exactly
# that one host - nothing else on the local network becomes reachable.
export OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'
exec npx -y @truefoundry/trueforge@latest "$@"
