import "dotenv/config";
import { Wallet, JsonRpcProvider, Interface, AbiCoder, getBytes } from "ethers";

const PRIVY_BASE = "https://privy.clashofcoins.com";
const GAME_API_BASE = "https://api.clashofcoins.com";
const APP_ORIGIN = "https://clashofcoins.com";

const PRIVY_APP_ID = "cm2tj674t004hp714qtb6f0zr";
const PRIVY_CA_ID = "0d853e55-e5b1-421b-96f1-d6bbb02ed784";
const PRIVY_CLIENT = "react-auth:2.0.1";

const CHAIN_ID_NUM = 8453;
const CHAIN_ID = `eip155:${CHAIN_ID_NUM}`;
const BASE_RPC_URL = (process.env.BASE_RPC_URL || "https://mainnet.base.org").trim();
const CLAIM_SELECTOR = "0x73b2e80e"; // observed from HAR: bool-view(address)
const RETRY_429_MAX = Number(process.env.RETRY_429_MAX || 6);
const PROXY_URL_RAW = (process.env.PROXY_URL || "").trim();

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Missing required env: ${name}`);
  return value.trim();
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setupProxyIfConfigured() {
  if (!PROXY_URL_RAW) return;
  const normalized = /^https?:\/\//i.test(PROXY_URL_RAW)
    ? PROXY_URL_RAW
    : `http://${PROXY_URL_RAW}`;
  try {
    const { setGlobalDispatcher, ProxyAgent } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(normalized));
    const u = new URL(normalized);
    console.log(`[net] proxy enabled via ${u.host}`);
  } catch (err) {
    throw new Error(
      `PROXY_URL is set but proxy setup failed (${err?.message || String(err)}). Run: npm install`
    );
  }
}

function computeRetryDelayMs(res, attempt) {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const sec = Number(retryAfter);
    if (Number.isFinite(sec) && sec > 0) return sec * 1000;
  }
  // exponential-ish backoff with cap
  return Math.min(1500 * attempt, 15000);
}

function formatErr(err) {
  return {
    message: err?.message || String(err),
    cause: err?.cause?.message || null,
    code: err?.cause?.code || err?.code || null
  };
}

async function fetchWith429Retry(url, options, label) {
  let lastRes = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY_429_MAX; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status !== 429) return res;
      lastRes = res;
      const body = await res.text();
      const waitMs = computeRetryDelayMs(res, attempt);
      console.log(`${label}: hit 429 (attempt ${attempt}/${RETRY_429_MAX}), wait ${waitMs}ms`);
      if (attempt >= RETRY_429_MAX) {
        throw new Error(`${label} failed (429): ${body}`);
      }
      await sleep(waitMs);
      continue;
    } catch (err) {
      lastErr = err;
      const info = formatErr(err);
      const waitMs = Math.min(1200 * attempt, 12000);
      console.log(
        `${label}: network error (attempt ${attempt}/${RETRY_429_MAX}) message=${info.message} cause=${info.cause} code=${info.code} wait=${waitMs}ms`
      );
      if (attempt >= RETRY_429_MAX) {
        throw new Error(
          `${label} network failed after retries: message=${info.message}; cause=${info.cause}; code=${info.code}`
        );
      }
      await sleep(waitMs);
    }
  }
  if (lastRes) return lastRes;
  throw lastErr || new Error(`${label} failed without response`);
}

function buildSiweMessage(address, nonce, issuedAt) {
  return `${new URL(APP_ORIGIN).host} wants you to sign in with your Ethereum account:\n${address}\n\nBy signing, you are proving you own this wallet and logging in. This does not initiate a transaction or cost any fees.\n\nURI: ${APP_ORIGIN}\nVersion: 1\nChain ID: ${CHAIN_ID_NUM}\nNonce: ${nonce}\nIssued At: ${issuedAt}\nResources:\n- https://privy.io`;
}

function commonPrivyHeaders() {
  return {
    accept: "application/json",
    "content-type": "application/json",
    origin: APP_ORIGIN,
    referer: `${APP_ORIGIN}/`,
    "privy-app-id": PRIVY_APP_ID,
    "privy-ca-id": PRIVY_CA_ID,
    "privy-client": PRIVY_CLIENT
  };
}

function gameBaseHeaders() {
  return {
    accept: "*/*",
    "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    origin: APP_ORIGIN,
    referer: `${APP_ORIGIN}/`,
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"
  };
}

function authVariants(auth) {
  const token = auth?.data?.token;
  const identityToken = auth?.data?.identity_token;
  const privyUid = auth?.privyUid;
  const variants = [];

  if (token) variants.push({ label: "authorization-token", headers: { authorization: `Bearer ${token}` } });
  if (identityToken) {
    variants.push({ label: "authorization-identity", headers: { authorization: `Bearer ${identityToken}` } });
    variants.push({ label: "x-identity-token", headers: { "x-identity-token": identityToken } });
    variants.push({ label: "x-privy-token", headers: { "x-privy-token": identityToken } });
  }
  variants.push({ label: "no-auth", headers: {} });
  if (privyUid) variants.push({ label: "privy-uid-only", headers: { "privy-uid": privyUid } });

  return variants;
}

async function initSiwe(address) {
  const res = await fetchWith429Retry(`${PRIVY_BASE}/api/v1/siwe/init`, {
    method: "POST",
    headers: commonPrivyHeaders(),
    body: JSON.stringify({ address })
  }, "siwe/init");
  const text = await res.text();
  if (!res.ok) throw new Error(`siwe/init failed (${res.status}): ${text}`);
  return parseJsonSafe(text);
}

async function authenticateSiwe(payload) {
  const res = await fetchWith429Retry(`${PRIVY_BASE}/api/v1/siwe/authenticate`, {
    method: "POST",
    headers: commonPrivyHeaders(),
    body: JSON.stringify(payload)
  }, "siwe/authenticate");
  const privyUid = res.headers.get("privy-uid");
  const text = await res.text();
  if (!res.ok) throw new Error(`siwe/authenticate failed (${res.status}): ${text}`);
  return { privyUid, data: parseJsonSafe(text) };
}

async function tryGameRequest({ method, path, body, auth }) {
  const url = `${GAME_API_BASE}${path}`;
  let lastResult = null;

  for (const variant of authVariants(auth)) {
    try {
      const headers = { ...gameBaseHeaders(), ...variant.headers };
      if (body) headers["content-type"] = "application/json";
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
      });
      const text = await res.text();
      const result = {
        strategy: variant.label,
        status: res.status,
        ok: res.ok,
        body: text,
        json: parseJsonSafe(text)
      };
      if (res.ok) return result;
      lastResult = result;
    } catch (err) {
      const e = err;
      lastResult = {
        strategy: variant.label,
        ok: false,
        networkError: e?.message || String(err),
        cause: e?.cause?.message || null,
        code: e?.cause?.code || null
      };
    }
  }

  return lastResult;
}

async function getWaitlistStatus(auth) {
  return tryGameRequest({ method: "GET", path: "/api/agentic/status", auth });
}

async function syncUserIfConfigured(auth) {
  const invitationCode = (process.env.INVITATION_CODE || "").trim();
  if (!invitationCode) return null;
  const registrationPage = (process.env.REGISTRATION_PAGE || "agentic").trim();
  return tryGameRequest({
    method: "PUT",
    path: "/api/user/",
    body: { invitationCode, registrationPage },
    auth
  });
}

async function joinWaitlist(auth) {
  return tryGameRequest({ method: "POST", path: "/api/agentic/join", auth });
}

async function getClaimSignature(auth, address, retries = 6) {
  let last = null;
  for (let i = 1; i <= retries; i++) {
    last = await tryGameRequest({
      method: "GET",
      path: `/api/agentic/claim-signature?address=${address}`,
      auth
    });
    if (last?.ok && last?.json?.signature) return last;
    const waitMs = Math.min(1000 * i, 5000);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return last;
}

async function ensureWaitlist(auth) {
  const invitationCode = (process.env.INVITATION_CODE || "").trim();
  const syncResult = await syncUserIfConfigured(auth);
  if (syncResult) {
    console.log(`syncUser: ${syncResult.status} via ${syncResult.strategy}`);
    if (syncResult.json) {
      console.log(
        `syncUser profile: invitedById=${syncResult.json.invitedById ?? null}, invitationCode=${syncResult.json.invitationCode ?? null}`
      );
    }
  } else {
    console.log("syncUser skipped (INVITATION_CODE empty)");
  }

  let status = await getWaitlistStatus(auth);
  if (status?.json?.agenticData) return status;

  // Join can return transient 500; retry and poll status.
  for (let i = 1; i <= 5; i++) {
    const join = await joinWaitlist(auth);
    console.log(`join attempt ${i}: ${join?.status ?? "err"} via ${join?.strategy ?? "n/a"} body=${join?.body ?? "n/a"}`);
    await new Promise((r) => setTimeout(r, 1000 * i));
    status = await getWaitlistStatus(auth);
    if (status?.json?.agenticData) return status;
  }

  if (!invitationCode) {
    throw new Error(
      "Wallet belum masuk waitlist. Isi INVITATION_CODE di .env lalu run lagi."
    );
  }
  throw new Error(`Failed to join waitlist. Last status response: ${JSON.stringify(status)}`);
}

function encodeViewClaimedCall(address) {
  const stripped = address.toLowerCase().replace("0x", "").padStart(64, "0");
  return `${CLAIM_SELECTOR}${stripped}`;
}

async function readClaimFlag(provider, contractAddress, address) {
  const data = encodeViewClaimedCall(address);
  const raw = await provider.call({ to: contractAddress, data });
  const bytes = getBytes(raw);
  const last = bytes.slice(-32);
  return last.some((b) => b !== 0);
}

async function sendClaimTx(wallet, contractAddress, claimData) {
  const tsMs = BigInt(claimData.ts);
  const tsSec = BigInt(Math.floor(Number(claimData.ts) / 1000));
  const abiCoder = AbiCoder.defaultAbiCoder();
  const candidates = [
    {
      abi: "raw-selector 0xaf04d0ce (uint256,bytes) ts=ms",
      data: `0xaf04d0ce${abiCoder.encode(["uint256", "bytes"], [tsMs, claimData.signature]).slice(2)}`
    },
    {
      abi: "raw-selector 0xaf04d0ce (uint256,bytes) ts=sec",
      data: `0xaf04d0ce${abiCoder.encode(["uint256", "bytes"], [tsSec, claimData.signature]).slice(2)}`
    },
    { abi: "function claim(address to, uint256 ts, bytes signature)", args: [claimData.to, tsMs, claimData.signature] },
    { abi: "function claim(address to, uint256 ts, bytes signature)", args: [claimData.to, tsSec, claimData.signature] },
    { abi: "function claim(uint256 ts, bytes signature)", args: [tsMs, claimData.signature] },
    { abi: "function claim(uint256 ts, bytes signature)", args: [tsSec, claimData.signature] },
    { abi: "function claim(uint256 ts, address to, bytes signature)", args: [tsMs, claimData.to, claimData.signature] },
    { abi: "function claim(uint256 ts, address to, bytes signature)", args: [tsSec, claimData.to, claimData.signature] },
    { abi: "function claim(bytes signature, uint256 ts, address to)", args: [claimData.signature, tsMs, claimData.to] },
    { abi: "function claim(bytes signature, uint256 ts, address to)", args: [claimData.signature, tsSec, claimData.to] }
  ];

  let lastError = null;
  for (const c of candidates) {
    try {
      const data = c.data
        ? c.data
        : (() => {
            const iface = new Interface([c.abi]);
            const fragment = iface.fragments[0];
            return iface.encodeFunctionData(fragment.name, c.args);
          })();

      // Preflight the exact calldata to avoid sending a tx that will surely revert.
      await wallet.provider.call({
        from: wallet.address,
        to: contractAddress,
        data
      });

      const gas = await wallet.provider.estimateGas({
        from: wallet.address,
        to: contractAddress,
        data
      });

      const tx = await wallet.sendTransaction({
        to: contractAddress,
        data,
        gasLimit: (gas * 120n) / 100n
      });
      const receipt = await tx.wait();
      return {
        abi: c.abi,
        txHash: tx.hash,
        status: receipt?.status ?? null,
        blockNumber: receipt?.blockNumber ?? null
      };
    } catch (err) {
      lastError = `${c.abi}: ${err?.message || String(err)}`;
    }
  }

  throw new Error(`All claim ABI candidates failed. Last error: ${lastError}`);
}

async function main() {
  await setupProxyIfConfigured();

  const privateKey = (process.env.PRIVATE_KEY || "").trim();
  const seedPhrase = (process.env.SEED_PHRASE || "").trim();
  const walletClientType = (process.env.WALLET_CLIENT_TYPE || "okx_wallet").trim();
  const connectorType = (process.env.CONNECTOR_TYPE || "injected").trim();
  const mode = (process.env.MODE || "login-or-sign-up").trim();

  let wallet;
  if (privateKey) wallet = new Wallet(privateKey);
  else if (seedPhrase) wallet = Wallet.fromPhrase(seedPhrase);
  else throw new Error("Missing wallet secret: set PRIVATE_KEY (preferred) or SEED_PHRASE");

  const address = wallet.address;
  console.log(`[1/7] init nonce for ${address}`);
  const initData = await initSiwe(address);

  const issuedAt = new Date().toISOString();
  const message = buildSiweMessage(address, initData.nonce, issuedAt);
  const signature = await wallet.signMessage(message);

  console.log("[2/7] authenticate SIWE");
  const auth = await authenticateSiwe({
    message,
    signature,
    chainId: CHAIN_ID,
    walletClientType,
    connectorType,
    mode
  });

  console.log("[3/7] ensure waitlist");
  const status = await ensureWaitlist(auth);
  console.log(`status: ${status?.status ?? "err"} hasAgentic=${!!status?.json?.agenticData}`);

  console.log("[4/7] get claim signature");
  const claimSigRes = await getClaimSignature(auth, address);
  if (!claimSigRes?.ok || !claimSigRes?.json?.signature) {
    throw new Error(`claim-signature failed: ${JSON.stringify(claimSigRes)}`);
  }
  const claimData = claimSigRes.json;
  const contractAddress = (process.env.CLAIM_CONTRACT || claimData.contractAddress).trim();
  if (!contractAddress) throw new Error("Missing claim contract address");

  console.log("[5/7] connect Base RPC");
  const provider = new JsonRpcProvider(BASE_RPC_URL, CHAIN_ID_NUM);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID_NUM) {
    throw new Error(`Wrong chain from RPC: ${network.chainId}. Expected ${CHAIN_ID_NUM}`);
  }
  const signer = wallet.connect(provider);

  console.log("[6/7] check claimed + send tx if needed");
  const claimFlagBefore = await readClaimFlag(provider, contractAddress, address);
  let txResult = null;
  if (!claimFlagBefore) {
    txResult = await sendClaimTx(signer, contractAddress, claimData);
  } else {
    console.log("claim flag already true before tx, skip send");
  }

  console.log("[7/7] verify");
  const claimFlagAfter = await readClaimFlag(provider, contractAddress, address);
  console.log(JSON.stringify({
    address,
    userId: auth.data?.user?.id,
    waitlist: !!status?.json?.agenticData,
    claimContract: contractAddress,
    claimFlagBefore,
    claimFlagAfter,
    txResult
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
