$lines = Get-Content -Path 'h:\45001\Documents\WXNN XiangCe\wxnn-photo-manager\preview.html' -Encoding UTF8
# script body: line 1028 (index 1027) to line 11892 (index 11891), </script> at line 11893
$body = $lines[1027..11891] -join "`n"
[System.IO.File]::WriteAllText("$env:TEMP\preview_check.js", $body, [System.Text.UTF8Encoding]::new($false))
node --check "$env:TEMP\preview_check.js"
Write-Host "ExitCode: $LASTEXITCODE"
