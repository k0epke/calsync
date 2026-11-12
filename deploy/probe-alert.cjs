// Correctly-shaped probe: sendTelegramAlert expects { token, chatId }.
(async () => {
  const config = await import('/opt/calsync/lib/config.js');
  await config.loadEnvFile('/opt/calsync/.env');
  const full = config.loadConfig();
  console.log('TOKEN_SET:', Boolean(full.alertTelegramToken));
  console.log('CHAT_ID_SET:', Boolean(full.alertTelegramChatId));
  const alerts = await import('/opt/calsync/lib/alerts.js');
  const r = await alerts.sendTelegramAlert(
    { token: full.alertTelegramToken, chatId: full.alertTelegramChatId },
    'CalSync alert channel live — failure alerts + the 08:00 daily digest are now active'
  );
  console.log('PROBE-RESULT:', JSON.stringify(r));
  process.exit(0);
})().catch(e => { console.error('PROBE-FAILED:', e && e.message ? e.message : e); process.exit(1); });
