// Standalone v2 transport; no legacy writer or installer.
function crmV2TelegramApi_(token, method, payload) {
  if (!token) throw Error('Dedicated TEST bot token missing');
  let response;
  try {
    response = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true, followRedirects: false,
    });
  } catch (_transportError) {
    // Apps Script's UrlFetch exception embeds the COMPLETE URL (including the
    // bot token). Never propagate or log its original message or stack.
    throw Error('Telegram ' + method + ': network unavailable');
  }
  let json;
  try { json = JSON.parse(response.getContentText()); }
  catch (_parseError) {
    throw Error('Telegram ' + method + ': invalid response (HTTP ' + response.getResponseCode() + ')');
  }
  if (response.getResponseCode() !== 200 || !json.ok) {
    const detail = String(json.description || response.getResponseCode())
      .replace(/\b\d{7,12}:[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
    throw Error('Telegram ' + method + ': ' + detail);
  }
  return json.result;
}

function crmV2SendTelegram_(token, chatId, text, markup) {
  const payload = { chat_id: chatId, text: text.slice(0, 3900) };
  if (markup) payload.reply_markup = markup;
  return crmV2TelegramApi_(token, 'sendMessage', payload);
}

function crmV2TgDeadLetter_(cfg, props, key, entry) {
  const deadKey = key.replace(/^TG_OUTBOX_/, 'TG_DEAD_');
  props.setProperty(deadKey, JSON.stringify(Object.assign({}, entry, {
    failedAt: new Date().toISOString(), reason: 'delivery_failed',
  })));
  props.setProperty('TG_FAILED_COUNT',
    String(Number(props.getProperty('TG_FAILED_COUNT') || 0) + 1));
  props.deleteProperty(key);
  const now = Date.now();
  if (!cfg.ownerChatId || now - Number(props.getProperty('TG_DELIVERY_ALERT_AT') || 0) < 6 * 3600000) return;
  props.setProperty('TG_DELIVERY_ALERT_AT', String(now));
  try {
    crmV2SendTelegram_(cfg.telegramToken, cfg.ownerChatId,
      '⚠️ Telegram не доставил ответ после трёх попыток. ' +
      'Сообщение сохранено; проверь /status и функцию служебный журнал TG_DEAD_.');
  } catch (_error) { Logger.log('Telegram dead-letter owner alert unavailable'); }
}

function crmV2TgDeliverOutbox_(cfg, props, onlyKey) {
  const keys = onlyKey ? [onlyKey] : Object.keys(props.getProperties())
    .filter(k => k.startsWith('TG_OUTBOX_')).sort().slice(0, 20);
  for (const key of keys) {
    const raw = props.getProperty(key);
    if (!raw) continue;
    let entry;
    try { entry = JSON.parse(raw); }
    catch (_error) {
      // Preserve malformed evidence instead of deleting the only copy.
      Logger.log(key + ': corrupt outbox entry requires operator review');
      continue;
    }
    if (entry.nextAt && Date.now() < entry.nextAt) continue;
    try {
      if (entry.editMessageId) {
        try {
          crmV2TelegramApi_(cfg.telegramToken, 'editMessageText', {
            chat_id: entry.chatId, message_id: entry.editMessageId,
            text: entry.reply.slice(0, 3900), reply_markup: entry.markup,
          });
        } catch (error) {
          // Replaying a completed edit after a crash is a successful no-op.
          if (/message is not modified/i.test(String(error.message))) {
            // No change is necessary.
          } else if (/message to edit not found|message can't be edited/i.test(String(error.message))) {
            crmV2SendTelegram_(cfg.telegramToken, entry.chatId, entry.reply, entry.markup);
          } else throw error;
        }
      } else crmV2SendTelegram_(cfg.telegramToken, entry.chatId, entry.reply, entry.markup);
      props.deleteProperty(key);
    } catch (error) {
      entry.attempts = (entry.attempts || 0) + 1;
      if (entry.attempts >= 3) {
        crmV2TgDeadLetter_(cfg, props, key, entry);
        Logger.log(key + ': response moved to dead-letter queue after three attempts');
      } else {
        entry.nextAt = Date.now() + Math.pow(2, entry.attempts - 1) * 60000;
        props.setProperty(key, JSON.stringify(entry));
      }
    }
  }
}

