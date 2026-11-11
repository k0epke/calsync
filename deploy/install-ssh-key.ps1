$ErrorActionPreference = 'Continue'
$f = 'C:\Users\r00t\.openclaw\workspace\calsync\deploy\bootstrap-admin.sh'
Write-Host 'CalSync bootstrap for clawed@170.39.225.163.'
Write-Host 'Expect up to a few password prompts (SSH password; sudo password if sudo is not yet passwordless). Type them at the prompts, never in chat.'
scp $f clawed@170.39.225.163:/tmp/bootstrap-admin.sh
if ($LASTEXITCODE -ne 0) { Write-Host "scp failed (exit $LASTEXITCODE) - re-run."; exit 1 }
ssh -t -o StrictHostKeyChecking=accept-new clawed@170.39.225.163 "bash /tmp/bootstrap-admin.sh; rm -f /tmp/bootstrap-admin.sh"
if ($LASTEXITCODE -eq 0) {
	Write-Host 'Complete. All further CalSync deploy work runs automatically over key auth.'
} else {
	Write-Host "Finished with exit $LASTEXITCODE - check which marker printed (KEY-INSTALLED / SUDO-READY / SUDO-ALREADY-PWLESS / SUDO-NOT-GRANTED)."
}
