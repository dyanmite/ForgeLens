# Start TrueForge in local mode for ForgeLens (Windows PowerShell).
# TrueForge's SSRF guard blocks MCP servers on private addresses by default.
# ForgeLens' editor MCP server listens on 127.0.0.1 only, so we allow exactly that host.
$env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1"]'
npx -y @truefoundry/trueforge@latest @args
