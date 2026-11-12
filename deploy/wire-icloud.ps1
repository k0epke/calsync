$ErrorActionPreference = 'Stop'
$receiver = 'C:\Users\r00t\.openclaw\workspace\calsync\deploy\wire-icloud-receiver.sh'
Write-Host 'CalSync: wiring iCloud CalDAV credentials into the server.'
$appleId = Read-Host 'Apple ID (the email you sign in to iCloud with)'
if ([string]::IsNullOrWhiteSpace($appleId)) { Write-Host 'No Apple ID entered - aborted.'; exit 1 }
Write-Host 'Paste the APP-SPECIFIC password when prompted (generated at appleid.apple.com; hidden input; never in chat).'
$sec = Read-Host -AsSecureString 'ICLOUD_APP_PASSWORD'
$ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$secret = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
if ([string]::IsNullOrWhiteSpace($secret)) { Write-Host 'No password entered - aborted.'; exit 1 }
scp -i C:\Users\r00t\.ssh\calsync_deploy -o BatchMode=yes $receiver clawed@170.39.225.163:/tmp/wire-icloud-receiver.sh
if ($LASTEXITCODE -ne 0) { Write-Host 'scp failed - aborted.'; exit 1 }
Write-Host 'Wiring (secret travels via stdin pipe only; not in argv, not in chat)...'
$snippet = "ICLOUD_APPLE_ID=$appleId`r`nICLOUD_APP_PASSWORD=$secret"
$snippet | ssh -i C:\Users\r00t\.ssh\calsync_deploy -o BatchMode=yes -o ConnectTimeout=10 clawed@170.39.225.163 "sudo bash /tmp/wire-icloud-receiver.sh"
ssh -i C:\Users\r00t\.ssh\calsync_deploy -o BatchMode=yes -o ConnectTimeout=10 clawed@170.39.225.163 "rm -f /tmp/wire-icloud-receiver.sh"
Write-Host 'Done. iCloud creds live in /opt/calsync/.env only.'
