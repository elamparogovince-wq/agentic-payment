#!/usr/bin/env node

// The browser demo is deliberately simulated. This CLI is the optional,
// explicit Stellar Testnet path: --check is read-only; --pay submits a payment.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

function loadEnv() {
  try {
    const contents = readFileSync(new URL('.env', import.meta.url), 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && !match[1].startsWith('#') && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
      }
    }
  } catch { /* .env is optional for the no-secret demo. */ }
}

function demo() {
  const cases = [
    { name: 'Delivery accepted', temperature: 5.2, checkpoint: true, amount: '2.00', allowed: true },
    { name: 'Temperature excursion', temperature: 10.4, checkpoint: true, amount: '2.00', allowed: false },
    { name: 'Over policy limit', temperature: 5.2, checkpoint: true, amount: '12.00', allowed: false },
  ];
  console.log('AEROPAY · OFFLINE DEMO (no network calls or transactions)\n');
  for (const item of cases) {
    const sensorOk = item.temperature >= 2 && item.temperature <= 8;
    const decision = sensorOk && item.checkpoint && item.allowed;
    console.log(`${decision ? 'ALLOW' : 'DENY '}  ${item.name}`);
    console.log(`      temperature ${item.temperature}°C · checkpoint ${item.checkpoint ? 'verified' : 'missing'} · ${item.amount} USDC`);
    console.log(`      ${decision ? 'Would authorize on-chain in live mode.' : 'Escrow stays locked; no payment submitted.'}\n`);
  }
  console.log('These are simulated outcomes. Run `npm run agent:check` for a live, read-only Testnet policy check.');
}

async function live(submit) {
  loadEnv();
  const required = ['DEVICE_HASH', 'AGENT_SECRET', 'MERCHANT_ADDRESS', 'ASSET_CONTRACT_ID', 'PAYMENT_AMOUNT'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Missing ${missing.join(', ')}. Copy .env.example to .env and fill in your Testnet values.`);
  const deviceHash = process.env.DEVICE_HASH.trim().replace(/^0x/i, '');
  if (!/^[a-f\d]{64}$/i.test(deviceHash)) throw new Error('DEVICE_HASH must be 64 hexadecimal characters (SHA-256).');
  if (!/^G[A-Z2-7]{55}$/.test(process.env.MERCHANT_ADDRESS)) throw new Error('MERCHANT_ADDRESS must be a Stellar public address beginning with G.');

  let sdk;
  try { sdk = await import('@noirx402/agent-sdk'); }
  catch { throw new Error('Live mode needs the Noir SDK. Run `npm install`, then try again.'); }

  const { NoirAgentClient, keypairSigner, toStroops } = sdk;
  const noir = new NoirAgentClient(); // built-in Stellar Testnet configuration
  const agent = keypairSigner(process.env.AGENT_SECRET.trim());
  const asset = process.env.ASSET_CONTRACT_ID.trim();
  const amount = toStroops(process.env.PAYMENT_AMOUNT.trim());
  console.log('AEROPAY · STELLAR TESTNET');
  console.log(`Device: ${deviceHash}\nAgent: ${agent.publicKey}\nAmount: ${process.env.PAYMENT_AMOUNT} · Asset: ${asset}`);

  const policy = await noir.getPolicy(deviceHash);
  if (!policy) throw new Error('No on-chain agent policy is registered for this device.');
  console.log(`Policy agent: ${policy.agent}\nPolicy cap: ${policy.maxAmount} stroops\nPolicy asset: ${policy.asset}`);
  const check = await noir.checkPayment({ deviceHash, agent: agent.publicKey, asset, amount });
  if (!check.ok) throw new Error(`Payment refused by Testnet policy: ${check.reason}. No transaction was sent.`);
  if (!submit) {
    console.log('ALLOW · Testnet policy check passed. Read-only mode; no transaction was sent.');
    return;
  }
  console.log('Submitting authorization transaction…');
  const result = await noir.authorizePayment({ agent, deviceHash, merchant: process.env.MERCHANT_ADDRESS, asset, amount });
  console.log(`AUTHORIZED · Transaction: ${result.hash}`);
  console.log('This authorizes payment from escrow. The merchant must separately claim pending funds.');
}

const args = process.argv.slice(2);
try {
  if (args.length === 0 || args[0] === '--demo') demo();
  else if (args[0] === '--check') await live(false);
  else if (args[0] === '--pay') await live(true);
  else {
    console.error('Usage: node agent.js [--demo | --check | --pay]');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`\nERROR · ${error.message}`);
  process.exitCode = 1;
}
