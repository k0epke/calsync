$ErrorActionPreference = 'Stop'
$receiver = 'C:\Users\r00t\.openclaw\workspace\calsync\deploy\wire-alerts-receiver.sh'
Write-Host 'CalSync: wiring Telegram failure alerts + daily digest into the server.'
Write-Host 'If you need the token: Telegram -> @BotFather -> /mybots -> @Koekalsyncbot -> API Token.'
$sec = Read-Host -AsSecureString 'BOT TOKEN (paste as BotFather shows it)'
$ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$token = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
if ([string]::IsNullOrWhiteSpace($token)) { Write-Host 'No token entered - aborted.'; exit 1 }
$tokenLine = "ALERT_TELEGRAM_TOKEN=$token"
scp -i C:\Users\r00t\.ssh\calsync_deploy -o BatchMode=yes $receiver clawed@170.39.225.163:/tmp/wire-alerts-receiver.sh
if ($LASTEXITCODE -ne 0) { Write-Host 'scp failed - aborted.'; exit 1 }
Write-Host 'Wiring (token travels via stdin pipe only; never chat, never argv)...'
$tokenLine | ssh -i C:\Users\r00t\.ssh\calsync_deploy -o BatchMode=yes -o ConnectTimeout=10 clawed@170.39.225.163 "sudo bash /tmp/wire-alerts-receiver.sh"
ssh -i C:\Users\r00t\.ssh\calsync_deploy -o BatchMode=yes -o ConnectTimeout=10 clawed@170.39.225.163 "rm -f /tmp/wire-alerts-receiver.sh"
Write-Host 'Done. Failure alerts (error/partial, 30-min dedup per pair) + 08:00 daily digest are live; success runs stay silent.'
