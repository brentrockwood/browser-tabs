import { SERVICE_URL } from "./service-client.js";

const browserApi = globalThis.browser ?? globalThis.chrome;

const tokenInput = document.getElementById("serviceToken");
const statusEl = document.getElementById("status");
const addressEl = document.getElementById("serviceAddress");

async function load() {
  addressEl.textContent = SERVICE_URL;
  const { serviceToken } = await browserApi.storage.local.get(["serviceToken"]);
  tokenInput.value = serviceToken || "";
}

document.getElementById("save").addEventListener("click", async () => {
  const serviceToken = tokenInput.value.trim();
  await browserApi.storage.local.set({ serviceToken });
  statusEl.textContent = serviceToken
    ? "Saved. The extension will connect using this token."
    : "Saved with an empty token. The extension will not attempt to connect until a token is set.";
});

load();
