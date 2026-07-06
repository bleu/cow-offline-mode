#!/usr/bin/env npx ts-node
/**
 * BYOS (Bring Your Own Solver) End-to-End Test
 *
 * This script bypasses the quote API (which doesn't work with BYOS since there
 * are no proposals yet) and instead computes swap amounts directly from the
 * Uniswap V2 router on-chain.
 *
 * Steps:
 * 1. Sets up trader with tokens and approval
 * 2. Computes swap amounts from Uniswap V2 router directly
 * 3. Places a sell order on the orderbook
 * 4. Signs and submits a proposal to BYOS
 * 5. Waits for the order to be settled
 *
 * Usage:
 *   npx ts-node scripts/orders/byos-test.ts
 *   npm run order:byos-test
 */

import { ethers } from "ethers";
import { loadAddresses } from "../../test/utils/loadAddresses";

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  rpcUrl: "http://localhost:8545",
  orderbookUrl: "http://localhost:8080",
  byosUrl: "http://localhost:9002",
  chainId: 1,
  // Alice (Anvil account #1) — pre-funded with 100k USDC
  traderKey:
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  // Separate key for the subsolver that signs proposals (Anvil account #3)
  solverKey:
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  sellToken: "USDC",
  buyToken: "WETH",
  sellAmount: "1000000000", // 1000 USDC (6 decimals)
  surplusPercent: 5, // 5% surplus tolerance for limit price
};

const addresses = loadAddresses();

const UNISWAP_V2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const SETTLEMENT = addresses.cowProtocol.settlement;
const VAULT_RELAYER = addresses.cowProtocol.vaultRelayer;

// ─── ABIs ────────────────────────────────────────────────────────────────────

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function mint(address to, uint256 amount) returns (bool)",
];

const UNISWAP_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory amounts)",
];

// ─── EIP-712 Types ───────────────────────────────────────────────────────────

const ORDER_TYPE_FIELDS = [
  { name: "sellToken", type: "address" },
  { name: "buyToken", type: "address" },
  { name: "receiver", type: "address" },
  { name: "sellAmount", type: "uint256" },
  { name: "buyAmount", type: "uint256" },
  { name: "validTo", type: "uint32" },
  { name: "appData", type: "bytes32" },
  { name: "feeAmount", type: "uint256" },
  { name: "kind", type: "string" },
  { name: "partiallyFillable", type: "bool" },
  { name: "sellTokenBalance", type: "string" },
  { name: "buyTokenBalance", type: "string" },
];

const BYOS_DOMAIN = {
  name: "BYOS",
  version: "1",
  chainId: CONFIG.chainId,
};

const PROPOSAL_TYPE_FIELDS = [
  { name: "orderUidHash", type: "bytes32" },
  { name: "sellAmount", type: "uint256" },
  { name: "buyAmount", type: "uint256" },
  { name: "validUntil", type: "uint256" },
  { name: "nonce", type: "uint256" },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getTokenAddress(symbol: string): string {
  return addresses.tokens[symbol as keyof typeof addresses.tokens];
}

async function waitForServices(): Promise<void> {
  console.log("Waiting for services...");
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`${CONFIG.orderbookUrl}/api/v1/version`);
      if (r.ok) {
        const r2 = await fetch(`${CONFIG.byosUrl}/healthz`);
        if (r2.ok) {
          console.log("  All services ready!\n");
          return;
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Services not ready");
}

function encodeApprove(spender: string, amount: bigint): string {
  const iface = new ethers.Interface(ERC20_ABI);
  return iface.encodeFunctionData("approve", [spender, amount]);
}

function encodeSwap(
  amountIn: bigint,
  amountOutMin: bigint,
  path: string[],
  to: string,
  deadline: bigint
): string {
  const iface = new ethers.Interface(UNISWAP_ROUTER_ABI);
  return iface.encodeFunctionData("swapExactTokensForTokens", [
    amountIn,
    amountOutMin,
    path,
    to,
    deadline,
  ]);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║       BYOS End-to-End Test                      ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
  const traderWallet = new ethers.Wallet(CONFIG.traderKey, provider);
  const solverWallet = new ethers.Wallet(CONFIG.solverKey, provider);

  const sellTokenAddr = getTokenAddress(CONFIG.sellToken);
  const buyTokenAddr = getTokenAddress(CONFIG.buyToken);

  console.log(`Trader:      ${traderWallet.address}`);
  console.log(`Solver:      ${solverWallet.address}`);
  console.log(`Sell:        ${CONFIG.sellToken} (${sellTokenAddr})`);
  console.log(`Buy:         ${CONFIG.buyToken} (${buyTokenAddr})`);
  console.log(`Settlement:  ${SETTLEMENT}`);
  console.log(`Router:      ${UNISWAP_V2_ROUTER}\n`);

  await waitForServices();

  // ── Step 1: Ensure trader has tokens and approval ──────────────────────
  console.log("Step 1: Setting up trader tokens & approval...");

  const sellToken = new ethers.Contract(sellTokenAddr, ERC20_ABI, traderWallet);

  const balance = await sellToken.balanceOf(traderWallet.address);
  const sellAmount = BigInt(CONFIG.sellAmount);
  if (balance < sellAmount * 2n) {
    console.log("  Minting USDC to trader...");
    const tx = await sellToken.mint(traderWallet.address, sellAmount * 3n);
    await tx.wait();
  }

  const allowance = await sellToken.allowance(
    traderWallet.address,
    VAULT_RELAYER
  );
  if (allowance < sellAmount) {
    console.log("  Approving VaultRelayer...");
    const tx = await sellToken.approve(VAULT_RELAYER, ethers.MaxUint256);
    await tx.wait();
  }

  const traderBalance = await sellToken.balanceOf(traderWallet.address);
  console.log(
    `  Trader USDC balance: ${(Number(traderBalance) / 1e6).toFixed(2)}\n`
  );

  // ── Step 2: Compute swap amounts from Uniswap V2 directly ─────────────
  console.log("Step 2: Computing swap amounts from Uniswap V2 router...");

  const router = new ethers.Contract(
    UNISWAP_V2_ROUTER,
    UNISWAP_ROUTER_ABI,
    provider
  );

  const path = [sellTokenAddr, buyTokenAddr];
  const amountsOut = await router.getAmountsOut(sellAmount, path);
  const expectedBuyAmount: bigint = amountsOut[1];

  // Limit buy amount = expected minus surplus tolerance
  const limitBuyAmount =
    (expectedBuyAmount *
      BigInt(Math.floor((1 - CONFIG.surplusPercent / 100) * 10000))) /
    10000n;

  console.log(`  Sell amount:     ${(Number(sellAmount) / 1e6).toFixed(2)} USDC`);
  console.log(`  Expected buy:    ${ethers.formatEther(expectedBuyAmount)} WETH`);
  console.log(
    `  Limit buy (${CONFIG.surplusPercent}%): ${ethers.formatEther(limitBuyAmount)} WETH\n`
  );

  // ── Step 3: Place the order (no quote needed) ──────────────────────────
  console.log("Step 3: Signing and placing order...");

  const block = await provider.getBlock("latest");
  const validTo = block!.timestamp + 600; // 10 minutes from now

  const orderData = {
    sellToken: sellTokenAddr,
    buyToken: buyTokenAddr,
    receiver: traderWallet.address,
    sellAmount: sellAmount.toString(),
    buyAmount: limitBuyAmount.toString(),
    validTo: validTo,
    appData: ethers.ZeroHash,
    feeAmount: "0",
    kind: "sell",
    partiallyFillable: false,
    sellTokenBalance: "erc20",
    buyTokenBalance: "erc20",
  };

  const cowDomain = {
    name: "Gnosis Protocol",
    version: "v2",
    chainId: CONFIG.chainId,
    verifyingContract: SETTLEMENT,
  };

  const orderSig = await traderWallet.signTypedData(
    cowDomain,
    { Order: ORDER_TYPE_FIELDS },
    orderData
  );

  const orderCreation = {
    ...orderData,
    signingScheme: "eip712",
    signature: orderSig,
    from: traderWallet.address,
  };

  const orderResp = await fetch(`${CONFIG.orderbookUrl}/api/v1/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(orderCreation),
  });

  if (!orderResp.ok) {
    const err = await orderResp.text();
    throw new Error(`Order placement failed: ${err}`);
  }

  const orderUid = (await orderResp.text()).replace(/"/g, "");
  console.log(`  Order UID: ${orderUid}\n`);

  // ── Step 4: Build and submit BYOS proposal ─────────────────────────────
  console.log("Step 4: Building BYOS proposal with Uniswap V2 interactions...");

  // Encode interactions: approve + swap
  const farFutureDeadline = BigInt("0xffffffffffffffff");

  const approveCalldata = encodeApprove(UNISWAP_V2_ROUTER, sellAmount);
  const swapCalldata = encodeSwap(
    sellAmount,
    limitBuyAmount,
    path,
    SETTLEMENT,
    farFutureDeadline
  );

  const interactions = [
    { target: sellTokenAddr, value: "0", calldata: approveCalldata },
    { target: UNISWAP_V2_ROUTER, value: "0", calldata: swapCalldata },
  ];

  console.log(`  Interactions: approve USDC + swapExactTokensForTokens`);

  // Sign BYOS proposal with EIP-712
  const orderUidBytes = ethers.getBytes(orderUid);
  const orderUidHash = ethers.keccak256(orderUidBytes);

  const proposalValidUntil = Math.floor(Date.now() / 1000) + 300;
  const nonce = Date.now();

  const proposalData = {
    orderUidHash: orderUidHash,
    sellAmount: sellAmount.toString(),
    buyAmount: expectedBuyAmount.toString(),
    validUntil: proposalValidUntil,
    nonce: nonce,
  };

  const proposalSig = await solverWallet.signTypedData(
    BYOS_DOMAIN,
    { ProposalData: PROPOSAL_TYPE_FIELDS },
    proposalData
  );

  const proposalBody = {
    orderUid: orderUid,
    sellAmount: sellAmount.toString(),
    buyAmount: expectedBuyAmount.toString(),
    interactions: interactions,
    validUntil: proposalValidUntil,
    nonce: nonce.toString(),
    signature: proposalSig,
  };

  console.log(`  Solver:      ${solverWallet.address}`);
  console.log(`  Sell amount: ${sellAmount} (${(Number(sellAmount) / 1e6).toFixed(2)} USDC)`);
  console.log(`  Buy amount:  ${expectedBuyAmount} (${ethers.formatEther(expectedBuyAmount)} WETH)`);

  const proposalResp = await fetch(`${CONFIG.byosUrl}/proposals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(proposalBody),
  });

  if (!proposalResp.ok) {
    const err = await proposalResp.text();
    throw new Error(
      `Proposal submission failed (${proposalResp.status}): ${err}`
    );
  }

  const proposalResult = (await proposalResp.json()) as any;
  console.log(`  Proposal ID: ${proposalResult.id}\n`);

  // ── Step 5: Wait for settlement ────────────────────────────────────────
  console.log("Step 5: Waiting for order to settle...");
  console.log("  (Checking every 5s for up to 2 minutes)\n");

  const maxWait = 120;
  let elapsed = 0;

  while (elapsed < maxWait) {
    try {
      const statusResp = await fetch(
        `${CONFIG.orderbookUrl}/api/v1/orders/${orderUid}`
      );
      const statusData = (await statusResp.json()) as any;
      const status = statusData.status || "unknown";
      console.log(`  [${elapsed}s] Status: ${status}`);

      if (status === "fulfilled" || status === "traded") {
        console.log("\n  Order settled successfully!");

        const buyTokenContract = new ethers.Contract(
          buyTokenAddr,
          ERC20_ABI,
          provider
        );
        const finalSell = await sellToken.balanceOf(traderWallet.address);
        const finalBuy = await buyTokenContract.balanceOf(
          traderWallet.address
        );
        console.log(
          `\n  Final USDC balance: ${(Number(finalSell) / 1e6).toFixed(2)}`
        );
        console.log(`  Final WETH balance: ${ethers.formatEther(finalBuy)}`);
        console.log("\n  TEST PASSED");
        return;
      }

      if (status === "cancelled" || status === "expired") {
        throw new Error(`Order ${status}`);
      }
    } catch (e: any) {
      if (e.message?.includes("Order")) throw e;
      console.log(`  [${elapsed}s] Error checking status: ${e.message}`);
    }

    await new Promise((r) => setTimeout(r, 5000));
    elapsed += 5;
  }

  // If we get here, check the driver/byos logs for clues
  console.log("\n  Order did not settle. Check logs:");
  console.log("    docker logs offline-mode-byos-1 --tail 30");
  console.log("    docker logs offline-mode-driver-1 --tail 30");
  console.log("    docker logs offline-mode-autopilot-1 --tail 30");
  throw new Error(`Order not settled within ${maxWait}s`);
}

main().catch((err) => {
  console.error("\nFAILED:", err.message || err);
  process.exit(1);
});
