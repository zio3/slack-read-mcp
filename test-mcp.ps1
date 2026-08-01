# MCP サーバーに JSON-RPC を直接流して動作を確認する。
#   .\test-mcp.ps1
#   .\test-mcp.ps1 -Tool get_channel_history -Arguments '{"channelId":"C0123456789"}'
#
# stdin を閉じるとレスポンス書き込み前にトランスポートが終了する実装があるため、
# 応答を読み終えるまで標準入力は開いたままにする。
param(
    [string]$Tool,
    [string]$Arguments = '{}'
)

$entry = Join-Path $PSScriptRoot 'dist\index.js'
if (-not (Test-Path $entry)) { throw "ビルドされていません。npm run build を実行してください。" }

$requests = @(
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
    '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
)
$expected = 2
if ($Tool) {
    $requests += (@{
        jsonrpc = '2.0'; id = 3; method = 'tools/call'
        params  = @{ name = $Tool; arguments = ($Arguments | ConvertFrom-Json) }
    } | ConvertTo-Json -Depth 10 -Compress)
    $expected = 3
}

$psi = [System.Diagnostics.ProcessStartInfo]@{
    FileName               = 'node'
    Arguments              = "`"$entry`""
    RedirectStandardInput  = $true
    RedirectStandardOutput = $true
    RedirectStandardError  = $true
    UseShellExecute        = $false
}
$proc = [System.Diagnostics.Process]::Start($psi)

foreach ($r in $requests) {
    $proc.StandardInput.WriteLine($r)
    $proc.StandardInput.Flush()
}

$responses = @()
while ($responses.Count -lt $expected) {
    $line = $proc.StandardOutput.ReadLine()
    if ($null -eq $line) { break }
    $responses += $line
}

$proc.StandardInput.Close()
if (-not $proc.WaitForExit(5000)) { $proc.Kill() }

foreach ($r in $responses) {
    $obj = $r | ConvertFrom-Json
    if ($obj.id -eq 2) {
        "=== tools/list ==="
        $obj.result.tools | ForEach-Object { "  {0,-22} {1}" -f $_.name, $_.description }
    }
    elseif ($obj.id -eq 3) {
        "=== tools/call: $Tool ==="
        if ($obj.error) { "  JSON-RPC error: $($obj.error.message)" }
        else { $obj.result.content | ForEach-Object { $_.text } }
    }
}
