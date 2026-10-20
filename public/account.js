/** Browser-native WebAuthn. This page only works against the authenticated API. */
const id = (name) => document.getElementById(name);
let backendAvailable = false;
let activeUser = false;

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
function enableButtons() {
  const supportsWebAuthn = typeof PublicKeyCredential !== "undefined" &&
    typeof navigator.credentials?.create === "function";
  id("registerButton").disabled = !backendAvailable || !supportsWebAuthn;
  id("loginButton").disabled = !backendAvailable || !supportsWebAuthn;
  id("logoutButton").disabled = !backendAvailable || !activeUser;
  id("realSubmit").disabled = !backendAvailable || !activeUser;
}
async function refresh() {
  try {
    await api("/api/status");
    backendAvailable = true;
    const state = await api("/api/me");
    activeUser = state.authenticated;
    id("authState").textContent = state.authenticated ? "ログイン済み" : "未ログイン";
    id("keyCount").textContent = state.authenticated ? String(state.credentialCount) : "—";
    id("postingDay").textContent = state.day;
    id("currentPost").textContent = state.post
      ? state.post.char + " (" + state.post.x + "," + state.post.y +
        ") / 変更 " + state.post.revision + " 回"
      : "投稿なし";
    id("environmentNotice").textContent =
      "開発用バックエンドに接続中。ユーザー情報はローカルSQLiteに保存されます。正式公開環境ではありません。";
  } catch {
    backendAvailable = false;
    activeUser = false;
    id("authState").textContent = "バックエンド未接続";
    id("environmentNotice").textContent =
      "静的デモでは実際のパスキー登録・ログイン・投稿保存はできません。開発用バックエンドで開いてください。";
  }
  enableButtons();
}
async function act(target, work) {
  setMessage(target, "処理中…");
  try {
    await work();
    await refresh();
    setMessage(target, "処理が完了しました。");
  } catch (error) {
    setMessage(target, error instanceof Error ? error.message : "処理に失敗しました。");
  }
}
id("registerButton").addEventListener("click", () => act("authMessage", async () => {
  const start = await api("/api/auth/register/start", {});
  const credential = await navigator.credentials.create({
    publicKey: registrationOptions(start.options),
  });
  if (!credential) throw new Error("パスキー作成がキャンセルされました。");
  await api("/api/auth/register/finish", { credential: registrationJSON(credential) });
}));
id("loginButton").addEventListener("click", () => act("authMessage", async () => {
  const start = await api("/api/auth/login/start", {});
  const credential = await navigator.credentials.get({
    publicKey: authenticationOptions(start.options),
  });
  if (!credential) throw new Error("パスキー認証がキャンセルされました。");
  await api("/api/auth/login/finish", { credential: authenticationJSON(credential) });
}));
id("logoutButton").addEventListener("click", () => act("authMessage", async () => {
  await api("/api/auth/logout", {});
}));
id("realPostForm").addEventListener("submit", (event) => {
  event.preventDefault();
  act("postMessage", async () => {
    await api("/api/post", {
      x: Number(id("realX").value),
      y: Number(id("realY").value),
      char: id("realChar").value,
    });
  });
});
await refresh();
