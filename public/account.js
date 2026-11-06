/** Browser-native WebAuthn. The backend remains the auth authority. */
import { initialAccountState, transitionAccount } from "./ui-state.js";

const id = (name) => document.getElementById(name);
let accountState = initialAccountState();

function fromBase64url(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}
function toBase64url(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function registrationOptions(json) {
  if (typeof PublicKeyCredential.parseCreationOptionsFromJSON === "function") {
    return PublicKeyCredential.parseCreationOptionsFromJSON(json);
  }
  return {
    ...json, challenge: fromBase64url(json.challenge),
    user: { ...json.user, id: fromBase64url(json.user.id) },
    excludeCredentials: (json.excludeCredentials ?? []).map((item) =>
      ({ ...item, id: fromBase64url(item.id) })),
  };
}
function authenticationOptions(json) {
  if (typeof PublicKeyCredential.parseRequestOptionsFromJSON === "function") {
    return PublicKeyCredential.parseRequestOptionsFromJSON(json);
  }
  return {
    ...json, challenge: fromBase64url(json.challenge),
    allowCredentials: (json.allowCredentials ?? []).map((item) =>
      ({ ...item, id: fromBase64url(item.id) })),
  };
}
function registrationJSON(result) {
  if (typeof result.toJSON === "function") return result.toJSON();
  return {
    id: result.id, rawId: toBase64url(result.rawId), type: result.type,
    response: {
      clientDataJSON: toBase64url(result.response.clientDataJSON),
      attestationObject: toBase64url(result.response.attestationObject),
      transports: result.response.getTransports?.() ?? [],
    },
    clientExtensionResults: result.getClientExtensionResults(),
  };
}
function authenticationJSON(result) {
  if (typeof result.toJSON === "function") return result.toJSON();
  return {
    id: result.id, rawId: toBase64url(result.rawId), type: result.type,
    response: {
      clientDataJSON: toBase64url(result.response.clientDataJSON),
      authenticatorData: toBase64url(result.response.authenticatorData),
      signature: toBase64url(result.response.signature),
      userHandle: result.response.userHandle
        ? toBase64url(result.response.userHandle) : null,
    },
    clientExtensionResults: result.getClientExtensionResults(),
  };
}
async function api(path, data) {
  const options = data === undefined ? { method: "GET" } : {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  };
  const response = await fetch(path, { ...options, credentials: "same-origin" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "HTTP " + response.status);
  return body;
}
function setMessage(target, value) {
  id(target).textContent = value;
}
const supportsCredentials = () =>
  typeof PublicKeyCredential !== "undefined" &&
  typeof navigator.credentials?.get === "function";
function enableButtons() {
  const phase = accountState.phase;
  const signedIn = phase === "authenticated";
  const signedOut = phase === "anonymous";
  const supportsRegistration = supportsCredentials() &&
    typeof navigator.credentials?.create === "function";
  id("registerButton").disabled = !(signedIn || signedOut) || !supportsRegistration;
  id("loginButton").disabled = !signedOut || !supportsCredentials();
  id("logoutButton").disabled = !signedIn;
  id("realSubmit").disabled = !signedIn;
  id("deleteAccountButton").disabled = !signedIn || !supportsCredentials();
  id("accountMain").setAttribute("aria-busy", String(phase === "busy"));
  id("operationStatus").textContent = phase === "busy"
    ? "処理中：ほかの操作は完了まで受け付けません。" : "";
}
async function refresh() {
  let available = false;
  let authenticated = false;
  try {
    const status = await api("/api/status");
    const state = await api("/api/me");
    available = true;
    authenticated = state.authenticated === true;
    id("authState").textContent = authenticated ? "ログイン済み" : "未ログイン";
    id("keyCount").textContent = authenticated ? String(state.credentialCount) : "—";
    id("postingDay").textContent = state.day;
    id("currentPost").textContent = state.post
      ? state.post.char + " (" + state.post.x + "," + state.post.y +
        ") / 変更 " + state.post.revision + " 回"
      : "投稿なし";
    id("environmentNotice").textContent = status.mode === "sites-d1"
      ? "Sites互換のD1バックエンドに接続中です。保存先を確認してください。この表示だけではサイトが一般公開済みとは判断できません。"
      : "ローカル開発用SQLiteバックエンドに接続中です。正式公開環境ではありません。";
  } catch {
    id("authState").textContent = "バックエンド未接続";
    id("keyCount").textContent = "—";
    id("postingDay").textContent = "—";
    id("currentPost").textContent = "—";
    id("environmentNotice").textContent =
      "バックエンドに接続できません。静的デモではパスキー登録・ログイン・投稿保存はできません。";
  }
  accountState = transitionAccount(accountState, {
    type: accountState.phase === "busy" ? "SETTLED" : "SYNC",
    available, authenticated,
  });
  enableButtons();
  return available;
}
async function act(target, operation, work) {
  // Busy is not merely a visual indication: overlapping async passkey
  // ceremonies can overwrite the single challenge cookie in the browser.
  if (accountState.phase === "busy") return;
  try {
    accountState = transitionAccount(accountState, { type: "BEGIN", operation });
  } catch {
    return;
  }
  enableButtons();
  setMessage(target, "処理中…");
  try {
    await work();
    const verified = await refresh();
    setMessage(target, verified
      ? "処理が完了しました。" : "処理の結果を確認できません。再接続して状態を確認してください。");
  } catch (error) {
    if (accountState.phase === "busy") {
      accountState = transitionAccount(accountState, { type: "FAILED" });
      enableButtons();
    }
    // The server remains authoritative. Revalidate session state after an
    // interrupted operation, without hiding the original error message.
    await refresh();
    setMessage(target, error instanceof Error ? error.message : "処理に失敗しました。");
  }
}
id("registerButton").addEventListener("click", () => act("authMessage", "register", async () => {
  const start = await api("/api/auth/register/start", {});
  const credential = await navigator.credentials.create({
    publicKey: registrationOptions(start.options),
  });
  if (!credential) throw new Error("パスキー作成がキャンセルされました。");
  await api("/api/auth/register/finish", { credential: registrationJSON(credential) });
}));
id("loginButton").addEventListener("click", () => act("authMessage", "login", async () => {
  const start = await api("/api/auth/login/start", {});
  const credential = await navigator.credentials.get({
    publicKey: authenticationOptions(start.options),
  });
  if (!credential) throw new Error("パスキー認証がキャンセルされました。");
  await api("/api/auth/login/finish", { credential: authenticationJSON(credential) });
}));
id("logoutButton").addEventListener("click", () => act("authMessage", "logout", async () => {
  await api("/api/auth/logout", {});
}));
id("realPostForm").addEventListener("submit", (event) => {
  event.preventDefault();
  act("postMessage", "post", async () => {
    await api("/api/post", {
      x: Number(id("realX").value),
      y: Number(id("realY").value),
      char: id("realChar").value,
    });
  });
});
id("deleteAccountButton").addEventListener("click", async () => {
  if (!window.confirm(
    "アカウント、認証情報、受付中の投稿、ログイン状態を削除します。締切済みの匿名投稿と日次確定したマップの文字は残ります。続行しますか？"
  )) return;
  if (window.prompt("最終確認: DELETE と入力してください。", "") !== "DELETE") {
    setMessage("deleteMessage", "削除を取り消しました。");
    return;
  }
  await act("deleteMessage", "delete", async () => {
    const start = await api("/api/account/delete/start", {});
    const assertion = await navigator.credentials.get({
      publicKey: authenticationOptions(start.options),
    });
    if (!assertion) throw new Error("再認証がキャンセルされました。");
    await api("/api/account/delete/finish", {
      confirm: "DELETE", credential: authenticationJSON(assertion),
    });
  });
});
await refresh();
