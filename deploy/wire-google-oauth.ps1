$ErrorActionPreference = 'Stop'
$cid = '994487527181-ud846fd4akdp4g77g37rdtufug3mmupv.apps.googleusercontent.com'
$receiver = 'C:\Users\r00t\.openclaw\workspace\calsync\deploy\wire-oauth-receiver.sh'
Write-Host 'CalSync: wire/rotate the Google OAuth client credentials on the server.'
Write-Host 'Paste the GOOGLE CLIENT SECRET when prompted (hidden input; it never enters chat).'
$sec = Read-Host -AsSecureString 'GOOGLE_CLIENT_SECRET'
$ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$secret = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
if ([string]::IsNullOrWhiteSpace($secret)) { Write-Host 'No secret entered - aborted.'; exit 1 }
scp -i C:\Users\r00t\.ssh\calsync_deploy -o BatchMode=yes $receiver clawed@170.39.225.163:/tmp/wire-oauth-receiver.sh
if ($LASTEXITCODE -ne 0) { Write-Host 'scp failed - aborted.'; exit 1 }
Write-Host 'Wiring...'
$snippet = "GOOGLE_CLIENT_ID=$cid`r`nGOOGLE_CLIENT_SECRET=$secret"
$snippet | ssh -i C:\Users\r00t\.ssh\calsync_deploy -o BatchMode=yes -o ConnectTimeout=10 clawed@170.39.225.163 "sudo bash /tmp/wire-oauth-receiver.sh"
ssh -i C:\Users\r00t\.ssh\calsync_deploy -o BatchMode=yes -o ConnectTimeout=10 clawed@170.39.225.163 "rm -f /tmp/wire-oauth-receiver.sh"
Write-Host 'Done. Secret stays in /opt/calsync/.env only.'
