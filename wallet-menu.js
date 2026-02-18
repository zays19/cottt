import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Wallet, JsonRpcProvider, Interface, parseEther, formatEther, formatUnits } from "ethers";

const BASE_RPC_URL = (process.env.BASE_RPC_URL || "https://mainnet.base.org").trim();
const DEFAULT_WALLETS_FILE = process.env.WALLETS_FILE || "wallets.json";
const FUND_AMOUNT_ETH = process.env.FUND_AMOUNT_ETH || "0.00003";
const SWEEP_RESERVE_ETH = process.env.SWEEP_RESERVE_ETH || "0.000002";
const OWB_TOKEN_CONTRACT = (process.env.OWB_TOKEN_CONTRACT || process.env.CLAIM_CONTRACT || "").trim();
const BALANCE_RETRIES = Number(process.env.BALANCE_RETRIES || 3);
const BALANCE_RETRY_MS = Number(process.env.BALANCE_RETRY_MS || 500);
const BASESCAN_API_KEY = (process.env.BASESCAN_API_KEY || "").trim();
const BASESCAN_API_URL = "https://api.basescan.org/api";
const ERC20_IFACE = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 value) returns (bool)"
]);
let activeWalletFile = path.resolve(process.cwd(), DEFAULT_WALLETS_FILE);

function logx(scope, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${scope}] ${msg}`);
}

function getMainPrivateKey() {
  return (process.env.MAIN_PRIVATE_KEY || process.env.PRIVATE_KEY || "").trim();
}

async function loadWallets() {
  try {
    const raw = await fs.readFile(activeWalletFile, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data;
  } catch {
    return [];
  }
}

async function saveWallets(wallets) {
  await fs.writeFile(activeWalletFile, JSON.stringify(wallets, null, 2), "utf8");
}

function walletFileLabel() {
  return path.basename(activeWalletFile);
}

function normalizeWalletFileName(inputName) {
  let name = (inputName || "").trim();
  if (!name) return null;
  if (!name.toLowerCase().endsWith(".json")) name = `${name}.json`;
  name = path.basename(name);
  return name;
}

async function listWalletJsonFiles() {
  const files = await fs.readdir(process.cwd());
  return files
    .filter((f) => /^wallets.*\.json$/i.test(f))
    .sort((a, b) => a.localeCompare(b));
}

function walletFileIndex(name) {
  const lower = name.toLowerCase();
  if (lower === "wallets.json") return 1;
  const m = /^wallets(\d+)\.json$/i.exec(lower);
  if (!m) return null;
  return Number(m[1]);
}

async function selectNextWalletFileForCreate() {
  const existing = await listWalletJsonFiles();
  let maxIndex = 0;
  for (const f of existing) {
    const idx = walletFileIndex(f);
    if (idx && idx > maxIndex) maxIndex = idx;
  }

  const nextIndex = maxIndex + 1;
  const nextName = nextIndex === 1 ? "wallets.json" : `wallets${nextIndex}.json`;
  activeWalletFile = path.resolve(process.cwd(), nextName);
  logx("FILE", `create mode -> auto file ${nextName}`);
}

function shortAddr(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function parseSelection(inputText, total) {
  const text = (inputText || "").trim().toLowerCase();
  if (text === "all") {
    return Array.from({ length: total }, (_, i) => i);
  }

  const selected = new Set();
  const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (part.includes("-")) {
      const [a, b] = part.split("-").map((n) => Number(n.trim()));
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const start = Math.min(a, b);
      const end = Math.max(a, b);
      for (let i = start; i <= end; i++) {
        if (i >= 1 && i <= total) selected.add(i - 1);
      }
      continue;
    }
    const n = Number(part);
    if (Number.isFinite(n) && n >= 1 && n <= total) selected.add(n - 1);
  }

  return [...selected].sort((x, y) => x - y);
}

function isNonceConflictError(err) {
  const msg = (err?.message || String(err)).toLowerCase();
  return (
    err?.code === "NONCE_EXPIRED" ||
    msg.includes("nonce too low") ||
    msg.includes("nonce has already been used")
  );
}

function errText(err) {
  return err?.message || err?.cause?.message || String(err);
}

async function mapWithWorkers(items, workerCount, handler) {
  const results = new Array(items.length);
  let cursor = 0;
  const totalWorkers = Math.max(1, Math.min(workerCount, items.length || 1));

  async function worker() {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) break;
      try {
        results[i] = await handler(items[i], i);
      } catch (err) {
        results[i] = { ok: false, error: errText(err) };
      }
    }
  }

  await Promise.all(Array.from({ length: totalWorkers }, () => worker()));
  return results;
}

async function retryRpcCall(fn, retries = BALANCE_RETRIES, waitMs = BALANCE_RETRY_MS) {
  let lastErr = null;
  for (let i = 1; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < retries) {
        await new Promise((r) => setTimeout(r, waitMs * i));
      }
    }
  }
  throw lastErr;
}

async function sweepEthMax(signer, to, reserveWei) {
  let totalSent = 0n;
  let txCount = 0;

  for (let i = 0; i < 4; i++) {
    const feeData = await signer.provider.getFeeData();
    const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
    if (!gasPrice) break;

    const bal = await signer.provider.getBalance(signer.address);
    const fee = gasPrice * 21000n;
    const sendable = bal - fee - reserveWei;
    if (sendable <= 0n) break;

    const tx = await signer.sendTransaction({
      to,
      value: sendable,
      gasLimit: 21000n,
      gasPrice
    });
    await tx.wait();
    totalSent += sendable;
    txCount += 1;
  }

  return { totalSent, txCount };
}

async function readTokenBalanceSafe(provider, token, owner) {
  try {
    const balRaw = await retryRpcCall(() =>
      provider.call({
        to: token,
        data: ERC20_IFACE.encodeFunctionData("balanceOf", [owner])
      })
    );
    const tokenBal = ERC20_IFACE.decodeFunctionResult("balanceOf", balRaw)[0];
    return { ok: true, balance: tokenBal, unverified: false, reason: null };
  } catch (err1) {
    // Fallback: raw selector 0x70a08231 + padded address
    try {
      const padded = owner.toLowerCase().replace("0x", "").padStart(64, "0");
      const data = `0x70a08231${padded}`;
      const raw = await retryRpcCall(() => provider.call({ to: token, data }));
      if (typeof raw === "string" && raw.length >= 66) {
        const bal = BigInt(raw);
        return { ok: true, balance: bal, unverified: true, reason: "fallback" };
      }
    } catch (err2) {
      return {
        ok: false,
        balance: 0n,
        unverified: true,
        reason: `${errText(err1)} | fallback: ${errText(err2)}`
      };
    }
    return { ok: false, balance: 0n, unverified: true, reason: errText(err1) };
  }
}

async function createManyWallets(rl) {
  const countText = await rl.question("Jumlah wallet dibuat: ");
  const count = Number(countText);
  if (!Number.isFinite(count) || count <= 0) {
    console.log("Jumlah tidak valid.");
    return;
  }

  const wallets = await loadWallets();
  const startIdx = wallets.length + 1;
  logx("CREATE", `mulai generate ${count} wallet...`);
  for (let i = 0; i < count; i++) {
    const w = Wallet.createRandom();
    wallets.push({
      address: w.address,
      privateKey: w.privateKey
    });
  }
  await saveWallets(wallets);
  const endIdx = wallets.length;
  logx("CREATE", `sukses create ${count} wallet (index ${startIdx}-${endIdx})`);
  logx("CREATE", `total tersimpan: ${wallets.length} | file: ${walletFileLabel()}`);
  logx("RESULT", `create | file=${walletFileLabel()} | dibuat=${count} | totalWallet=${wallets.length}`);
}

async function fundManyWallets(rl) {
  const mainPk = getMainPrivateKey();
  if (!mainPk) {
    console.log("Set MAIN_PRIVATE_KEY (atau PRIVATE_KEY) di .env dulu.");
    return;
  }

  const wallets = await loadWallets();
  if (wallets.length === 0) {
    console.log("Wallet list kosong. Buat wallet dulu.");
    return;
  }

  const pick = await rl.question(
    `Pilih index tujuan fund (contoh: 1,2,4 | 1-5 | all). Total ${wallets.length}: `
  );
  const indices = parseSelection(pick, wallets.length);
  if (indices.length === 0) {
    console.log("Tidak ada wallet yang terpilih.");
    return;
  }

  const amountInput = (await rl.question(
    `Nominal fund per wallet (ETH, default ${FUND_AMOUNT_ETH}): `
  )).trim();
  const amountText = amountInput || FUND_AMOUNT_ETH;

  let amount;
  try {
    amount = parseEther(amountText);
  } catch {
    console.log("Nominal ETH tidak valid.");
    return;
  }

  const provider = new JsonRpcProvider(BASE_RPC_URL, 8453);
  const main = new Wallet(mainPk, provider);
  let nextNonce = await provider.getTransactionCount(main.address, "pending");
  logx(
    "FUND",
    `mulai funding ${indices.length} wallet, masing-masing ${amountText} ETH dari ${main.address} (start nonce ${nextNonce})`
  );

  let ok = 0;
  let fail = 0;
  let totalFundedWei = 0n;
  for (const idx of indices) {
    const w = wallets[idx];
    let sent = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const tx = await main.sendTransaction({
          to: w.address,
          value: amount,
          nonce: nextNonce
        });
        logx("FUND", `SUBMIT #${idx + 1} nonce=${nextNonce} ${shortAddr(w.address)} tx=${tx.hash}`);
        await tx.wait();
        ok++;
        totalFundedWei += amount;
        sent = true;
        logx("FUND", `OK #${idx + 1} nonce=${nextNonce} ${shortAddr(w.address)} tx=${tx.hash}`);
        nextNonce += 1;
        break;
      } catch (err) {
        if (isNonceConflictError(err) && attempt < 3) {
          const chainNonce = await provider.getTransactionCount(main.address, "pending");
          logx(
            "FUND",
            `RETRY #${idx + 1} nonce conflict (attempt ${attempt}/3). localNonce=${nextNonce} chainNonce=${chainNonce}`
          );
          nextNonce = chainNonce;
          continue;
        }
        fail++;
        logx("FUND", `FAIL #${idx + 1} nonce=${nextNonce} ${shortAddr(w.address)}: ${err?.message || String(err)}`);
        break;
      }
    }
    if (!sent) {
      // keep progress with latest pending nonce before next wallet.
      nextNonce = await provider.getTransactionCount(main.address, "pending");
    }
  }
  logx("FUND", `selesai. success=${ok} failed=${fail}`);
  logx(
    "RESULT",
    `fund | file=${walletFileLabel()} | totalWalletDipilih=${indices.length} | berhasil=${ok} | gagal=${fail} | totalETHTerkirim=${formatEther(totalFundedWei)}`
  );
}

async function runClaimForWallet(privateKey, idx, total) {
  return new Promise((resolve) => {
    const env = { ...process.env, PRIVATE_KEY: privateKey };
    const child = spawn("node", ["login-siwe.js"], {
      cwd: process.cwd(),
      env,
      stdio: "pipe"
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      const t = d.toString();
      out += t;
      process.stdout.write(`[${idx}/${total}] ${t}`);
    });
    child.stderr.on("data", (d) => {
      const t = d.toString();
      err += t;
      process.stderr.write(`[${idx}/${total}] ${t}`);
    });
    child.on("close", (code) => {
      resolve({ code, out, err });
    });
  });
}

async function claimManyWallets() {
  const wallets = await loadWallets();
  if (wallets.length === 0) {
    console.log("Wallet list kosong. Buat/import wallet dulu.");
    return;
  }
  const workers = wallets.length;
  logx("CLAIM", `mulai claim untuk ${wallets.length} wallet | workers=${workers}`);
  const results = await mapWithWorkers(wallets, workers, async (w, i) => {
    logx("CLAIM", `wallet ${i + 1}/${wallets.length} ${w.address}`);
    const res = await runClaimForWallet(w.privateKey, i + 1, wallets.length);
    if (res.code !== 0) {
      logx("CLAIM", `FAIL ${shortAddr(w.address)} exit=${res.code}`);
      return { ok: false };
    }
    logx("CLAIM", `OK ${shortAddr(w.address)}`);
    return { ok: true };
  });
  const ok = results.filter((r) => r?.ok).length;
  const fail = wallets.length - ok;
  logx(
    "RESULT",
    `claim | file=${walletFileLabel()} | totalWallet=${wallets.length} | berhasil=${ok} | gagal=${fail}`
  );
}

async function sweepToMain(rl) {
  const mainPk = getMainPrivateKey();
  if (!mainPk) {
    console.log("Set MAIN_PRIVATE_KEY (atau PRIVATE_KEY) di .env dulu.");
    return;
  }

  const wallets = await loadWallets();
  if (wallets.length === 0) {
    console.log("Wallet list kosong.");
    return;
  }

  const provider = new JsonRpcProvider(BASE_RPC_URL, 8453);
  const main = new Wallet(mainPk, provider);
  const reserveInput = (await rl.question(
    `Reserve ETH per wallet (default ${SWEEP_RESERVE_ETH}, isi 0 untuk sweep maksimal): `
  )).trim();
  const reserveText = reserveInput || SWEEP_RESERVE_ETH;
  let reserveWei;
  try {
    reserveWei = parseEther(reserveText);
  } catch {
    console.log("Reserve ETH tidak valid.");
    return;
  }
  const sweepTokenAns = (await rl.question("Sekalian sweep OWB token ke wallet utama? (y/N): ")).trim().toLowerCase();
  const sweepToken = sweepTokenAns === "y" || sweepTokenAns === "yes";

  logx("SWEEP", `mulai sweep ke main ${main.address} | reserve=${reserveText} ETH`);
  let ethOk = 0;
  let ethFail = 0;
  let ethSkipped = 0;
  let ethSweptWei = 0n;
  let tokenOk = 0;
  let tokenFail = 0;
  let tokenSkipped = 0;
  let tokenSweptRaw = 0n;

  const candidates = wallets.filter((w) => w.address.toLowerCase() !== main.address.toLowerCase());
  const workers = candidates.length || 1;
  logx("SWEEP", `parallel workers=${workers}`);

  const perWallet = await mapWithWorkers(candidates, workers, async (w) => {
    let rEthOk = 0;
    let rEthFail = 0;
    let rEthSkipped = 0;
    let rEthSweptWei = 0n;
    let rTokenOk = 0;
    let rTokenFail = 0;
    let rTokenSkipped = 0;
    let rTokenSweptRaw = 0n;
    try {
      const signer = new Wallet(w.privateKey, provider);

      if (sweepToken && OWB_TOKEN_CONTRACT) {
        try {
          const tokenInfo = await readTokenBalanceSafe(provider, OWB_TOKEN_CONTRACT, w.address);
          if (tokenInfo.ok && tokenInfo.balance > 0n) {
            const feeDataToken = await provider.getFeeData();
            const gasPriceToken = feeDataToken.gasPrice || feeDataToken.maxFeePerGas;
            if (gasPriceToken) {
              const tokenData = ERC20_IFACE.encodeFunctionData("transfer", [main.address, tokenInfo.balance]);
              const estGas = await provider.estimateGas({
                from: signer.address,
                to: OWB_TOKEN_CONTRACT,
                data: tokenData
              });
              const needFee = (estGas * gasPriceToken * 120n) / 100n;
              const balEthBeforeToken = await provider.getBalance(w.address);
              if (balEthBeforeToken > needFee) {
                const txToken = await signer.sendTransaction({
                  to: OWB_TOKEN_CONTRACT,
                  data: tokenData,
                  gasLimit: (estGas * 120n) / 100n,
                  gasPrice: gasPriceToken
                });
                await txToken.wait();
                rTokenOk++;
                rTokenSweptRaw += tokenInfo.balance;
                logx("SWEEP", `TOKEN OK ${shortAddr(w.address)} -> ${main.address} amount=${tokenInfo.balance.toString()} tx=${txToken.hash}`);
              } else {
                rTokenSkipped++;
                logx("SWEEP", `TOKEN SKIP ${shortAddr(w.address)} saldo ETH kurang utk gas token transfer`);
              }
            } else {
              rTokenSkipped++;
              logx("SWEEP", `TOKEN SKIP ${shortAddr(w.address)} gagal baca gas price`);
            }
          }
        } catch (err) {
          rTokenFail++;
          logx("SWEEP", `TOKEN FAIL ${shortAddr(w.address)}: ${err?.message || String(err)}`);
        }
      }

      const balBefore = await provider.getBalance(w.address);
      if (balBefore <= reserveWei) {
        rEthSkipped++;
        logx("SWEEP", `SKIP ${shortAddr(w.address)} saldo kecil (${formatEther(balBefore)} ETH)`);
        return {
          ethOk: rEthOk, ethFail: rEthFail, ethSkipped: rEthSkipped, ethSweptWei: rEthSweptWei,
          tokenOk: rTokenOk, tokenFail: rTokenFail, tokenSkipped: rTokenSkipped, tokenSweptRaw: rTokenSweptRaw
        };
      }
      const result = await sweepEthMax(signer, main.address, reserveWei);
      const balAfter = await provider.getBalance(w.address);
      if (result.txCount > 0) {
        rEthOk++;
        rEthSweptWei += result.totalSent;
        logx(
          "SWEEP",
          `OK ${shortAddr(w.address)} txCount=${result.txCount} swept=${formatEther(result.totalSent)} ETH sisa=${formatEther(balAfter)} ETH`
        );
      } else {
        rEthSkipped++;
        logx("SWEEP", `SKIP ${shortAddr(w.address)} tidak ada nilai kirim (sisa=${formatEther(balAfter)} ETH)`);
      }
    } catch (err) {
      rEthFail++;
      logx("SWEEP", `FAIL ${shortAddr(w.address)}: ${err?.message || String(err)}`);
    }
    return {
      ethOk: rEthOk, ethFail: rEthFail, ethSkipped: rEthSkipped, ethSweptWei: rEthSweptWei,
      tokenOk: rTokenOk, tokenFail: rTokenFail, tokenSkipped: rTokenSkipped, tokenSweptRaw: rTokenSweptRaw
    };
  });

  for (const r of perWallet) {
    if (!r) continue;
    ethOk += r.ethOk || 0;
    ethFail += r.ethFail || 0;
    ethSkipped += r.ethSkipped || 0;
    ethSweptWei += r.ethSweptWei || 0n;
    tokenOk += r.tokenOk || 0;
    tokenFail += r.tokenFail || 0;
    tokenSkipped += r.tokenSkipped || 0;
    tokenSweptRaw += r.tokenSweptRaw || 0n;
  }

  logx(
    "RESULT",
    `sweep | file=${walletFileLabel()} | totalWallet=${wallets.length} | ethBerhasil=${ethOk} | ethGagal=${ethFail} | ethSkip=${ethSkipped} | totalETH=${formatEther(ethSweptWei)}`
  );
  if (sweepToken && OWB_TOKEN_CONTRACT) {
    logx(
      "RESULT",
      `sweep-token | file=${walletFileLabel()} | tokenBerhasil=${tokenOk} | tokenGagal=${tokenFail} | tokenSkip=${tokenSkipped} | totalRaw=${tokenSweptRaw.toString()}`
    );
  }
}

async function showSummary() {
  const wallets = await loadWallets();
  console.log(`wallet file aktif: ${walletFileLabel()}`);
  console.log(`jumlah wallet: ${wallets.length}`);
  if (wallets[0]?.address) console.log(`contoh: ${wallets[0].address}`);
}

async function selectWalletFile(rl) {
  const existing = await listWalletJsonFiles();
  console.log(`file aktif saat ini: ${walletFileLabel()}`);
  if (existing.length > 0) {
    console.log("wallet files terdeteksi:");
    existing.forEach((f, i) => console.log(`${i + 1}) ${f}`));
  } else {
    console.log("belum ada wallet*.json lain.");
  }

  const input = (await rl.question(
    "Pilih nomor file, atau ketik nama file baru (contoh wallets2.json): "
  )).trim();
  if (!input) return;

  let nextName = null;
  const n = Number(input);
  if (Number.isFinite(n) && n >= 1 && n <= existing.length) {
    nextName = existing[n - 1];
  } else {
    nextName = normalizeWalletFileName(input);
  }

  if (!nextName) {
    console.log("Nama file tidak valid.");
    return;
  }

  activeWalletFile = path.resolve(process.cwd(), nextName);
  const wallets = await loadWallets();
  logx("FILE", `aktif: ${walletFileLabel()} (wallet count ${wallets.length})`);
}

async function selectWalletFileForAction(rl, actionLabel) {
  const existing = await listWalletJsonFiles();
  console.log(`\n[${actionLabel}] file aktif: ${walletFileLabel()}`);
  if (existing.length > 0) {
    console.log("wallet files:");
    existing.forEach((f, i) => console.log(`${i + 1}) ${f}`));
  }
  const input = (await rl.question(
    `Pilih file wallet untuk ${actionLabel} (nomor/nama, Enter=pakai ${walletFileLabel()}): `
  )).trim();
  if (!input) return;

  let nextName = null;
  const n = Number(input);
  if (Number.isFinite(n) && n >= 1 && n <= existing.length) {
    nextName = existing[n - 1];
  } else {
    nextName = normalizeWalletFileName(input);
  }

  if (!nextName) {
    console.log("Nama file tidak valid, pakai file aktif saat ini.");
    return;
  }
  activeWalletFile = path.resolve(process.cwd(), nextName);
  const wallets = await loadWallets();
  logx("FILE", `aktif: ${walletFileLabel()} (wallet count ${wallets.length})`);
}

async function checkBalances(rl) {
  const wallets = await loadWallets();
  if (wallets.length === 0) {
    console.log("Wallet list kosong.");
    return;
  }

  const pick = await rl.question(
    `Pilih index wallet (contoh: 1,2,4 atau 1-5 atau 1,3-6,9 atau all). Total ${wallets.length}: `
  );
  const indices = parseSelection(pick, wallets.length);
  if (indices.length === 0) {
    console.log("Tidak ada wallet yang terpilih.");
    return;
  }

  const provider = new JsonRpcProvider(BASE_RPC_URL, 8453);
  let tokenMeta = null;
  if (OWB_TOKEN_CONTRACT) {
    try {
      const [decRaw, symRaw] = await Promise.all([
        provider.call({ to: OWB_TOKEN_CONTRACT, data: ERC20_IFACE.encodeFunctionData("decimals", []) }),
        provider.call({ to: OWB_TOKEN_CONTRACT, data: ERC20_IFACE.encodeFunctionData("symbol", []) })
      ]);
      const dec = Number(ERC20_IFACE.decodeFunctionResult("decimals", decRaw)[0]);
      const sym = String(ERC20_IFACE.decodeFunctionResult("symbol", symRaw)[0]);
      tokenMeta = { decimals: dec, symbol: sym };
      logx("BAL", `token check enabled: ${sym} @ ${OWB_TOKEN_CONTRACT}`);
    } catch {
      logx("BAL", `token check unavailable for contract ${OWB_TOKEN_CONTRACT}`);
    }
  }

  let totalEthWei = 0n;
  let totalOwbRaw = 0n;
  let owbVerifiedCount = 0;
  let owbUnverifiedCount = 0;

  const workers = indices.length;
  logx("BAL", `parallel workers=${workers}`);
  const perWallet = await mapWithWorkers(indices, workers, async (idx) => {
    const w = wallets[idx];
    try {
      const ethBal = await retryRpcCall(() => provider.getBalance(w.address));
      let owbText = "OWB: n/a";
      let owbRaw = 0n;
      let owbVerified = 0;
      let owbUnverified = 0;
      if (tokenMeta) {
        const r = await readTokenBalanceSafe(provider, OWB_TOKEN_CONTRACT, w.address);
        if (r.ok) {
          owbRaw = r.balance;
          owbVerified = 1;
          const suffix = r.unverified ? " (fallback)" : "";
          owbText = `${tokenMeta.symbol}: ${formatUnits(r.balance, tokenMeta.decimals)}${suffix}`;
        } else {
          owbUnverified = 1;
          owbText = `${tokenMeta.symbol}: 0 (unverified)`;
          logx("BAL", `detail #${idx + 1} ${shortAddr(w.address)} token read fail: ${r.reason}`);
        }
      }
      logx("BAL", `#${idx + 1} ${w.address} => ETH: ${formatEther(ethBal)} | ${owbText}`);
      return { ethBal, owbRaw, owbVerified, owbUnverified };
    } catch (err) {
      logx("BAL", `#${idx + 1} ${w.address} => gagal cek saldo: ${errText(err)}`);
      return { ethBal: 0n, owbRaw: 0n, owbVerified: 0, owbUnverified: tokenMeta ? 1 : 0 };
    }
  });

  for (const r of perWallet) {
    totalEthWei += r.ethBal || 0n;
    totalOwbRaw += r.owbRaw || 0n;
    owbVerifiedCount += r.owbVerified || 0;
    owbUnverifiedCount += r.owbUnverified || 0;
  }

  const owbLabel = tokenMeta ? tokenMeta.symbol : "OWB";
  const owbTotal = tokenMeta ? formatUnits(totalOwbRaw, tokenMeta.decimals) : "n/a";
  logx(
    "RESULT",
    `balance | file=${walletFileLabel()} | totalWalletDicek=${indices.length} | totalETH=${formatEther(totalEthWei)} | total${owbLabel}=${owbTotal} | owbVerified=${owbVerifiedCount} | owbUnverified=${owbUnverifiedCount}`
  );
}

async function verifyOwbViaBasescan(rl) {
  const wallets = await loadWallets();
  if (wallets.length === 0) {
    console.log("Wallet list kosong.");
    return;
  }
  if (!OWB_TOKEN_CONTRACT) {
    console.log("Set OWB_TOKEN_CONTRACT (atau CLAIM_CONTRACT) di .env dulu.");
    return;
  }

  const pick = await rl.question(
    `Pilih index wallet utk verify BaseScan (contoh: 1,2,4 | 1-5 | all). Total ${wallets.length}: `
  );
  const indices = parseSelection(pick, wallets.length);
  if (indices.length === 0) {
    console.log("Tidak ada wallet yang terpilih.");
    return;
  }

  const apiKey = BASESCAN_API_KEY || "YourApiKeyToken";
  logx("BSCAN", `verify ${indices.length} wallet via BaseScan token=${OWB_TOKEN_CONTRACT}`);
  const workers = indices.length;
  logx("BSCAN", `parallel workers=${workers}`);
  const results = await mapWithWorkers(indices, workers, async (idx) => {
    const w = wallets[idx];
    try {
      const u = new URL(BASESCAN_API_URL);
      u.searchParams.set("module", "account");
      u.searchParams.set("action", "tokenbalance");
      u.searchParams.set("contractaddress", OWB_TOKEN_CONTRACT);
      u.searchParams.set("address", w.address);
      u.searchParams.set("tag", "latest");
      u.searchParams.set("apikey", apiKey);

      const res = await fetch(u.toString());
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }

      if (!res.ok || !data) {
        logx("BSCAN", `#${idx + 1} ${w.address} => FAIL http=${res.status} body=${text}`);
        return { ok: false, raw: 0n };
      }

      // Etherscan-style: { status, message, result }
      const raw = data.result;
      if (typeof raw === "string" && /^\d+$/.test(raw)) {
        // OWB from your logs appears to be 18 decimals.
        const rawBn = BigInt(raw);
        const val = formatUnits(BigInt(raw), 18);
        logx("BSCAN", `#${idx + 1} ${w.address} => OWB: ${val}`);
        return { ok: true, raw: rawBn };
      } else {
        logx("BSCAN", `#${idx + 1} ${w.address} => FAIL status=${data.status} message=${data.message} result=${data.result}`);
        return { ok: false, raw: 0n };
      }
    } catch (err) {
      logx("BSCAN", `#${idx + 1} ${w.address} => FAIL ${errText(err)}`);
      return { ok: false, raw: 0n };
    }
  });
  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  const totalRaw = results.reduce((acc, r) => acc + (r.raw || 0n), 0n);
  logx(
    "RESULT",
    `basescan | file=${walletFileLabel()} | totalWalletDicek=${indices.length} | berhasil=${ok} | gagal=${fail} | totalOWB=${formatUnits(totalRaw, 18)}`
  );
}

async function main() {
  const rl = createInterface({ input, output });
  console.log("OWB Batch Menu");
  console.log(`Wallet file aktif: ${walletFileLabel()}`);
  console.log("1) Create wallet massal");
  console.log("2) Fund wallet massal dari wallet utama");
  console.log("3) Claim OWB wallet massal");
  console.log("4) Sweep saldo ke wallet utama");
  console.log("5) Lihat ringkasan wallet");
  console.log("6) Cek saldo wallet (selector / all)");
  console.log("7) Verify OWB via BaseScan");
  console.log("8) Pilih/ganti wallet file");
  console.log("0) Exit");

  while (true) {
    const ans = (await rl.question("\nPilih menu: ")).trim();
    if (ans === "1") {
      await selectNextWalletFileForCreate();
      await createManyWallets(rl);
    } else if (ans === "2") {
      await selectWalletFileForAction(rl, "fund");
      await fundManyWallets(rl);
    } else if (ans === "3") {
      await selectWalletFileForAction(rl, "claim");
      await claimManyWallets();
    } else if (ans === "4") {
      await selectWalletFileForAction(rl, "sweep");
      await sweepToMain(rl);
    } else if (ans === "5") {
      await selectWalletFileForAction(rl, "summary");
      await showSummary();
    } else if (ans === "6") {
      await selectWalletFileForAction(rl, "balance");
      await checkBalances(rl);
    } else if (ans === "7") {
      await selectWalletFileForAction(rl, "basescan-verify");
      await verifyOwbViaBasescan(rl);
    }
    else if (ans === "8") await selectWalletFile(rl);
    else if (ans === "0") break;
    else console.log("Pilihan tidak valid.");
  }

  rl.close();
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
