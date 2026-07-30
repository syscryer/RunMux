param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $RunMuxArgs
)

$ErrorActionPreference = "Stop"
$ScriptPath = Join-Path $PSScriptRoot "runmux.mjs"

node $ScriptPath @RunMuxArgs
exit $LASTEXITCODE
