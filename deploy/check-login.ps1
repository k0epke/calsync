$ErrorActionPreference = 'Stop'
$jar = Join-Path $env:TEMP 'calsync-jar4'
Remove-Item $jar -ErrorAction SilentlyContinue
$code = curl.exe -sS -c $jar -o NUL -w '%{http_code}' --data-urlencode 'username=admin' --data-urlencode 'password=5c90c9759faff3e583286b17' https://kalsync.koepke.tech/login
Write-Output ("LOGIN:" + $code)
$dash = curl.exe -sS -b $jar -o NUL -w '%{http_code}' https://kalsync.koepke.tech/
Write-Output ("DASHBOARD:" + $dash)
