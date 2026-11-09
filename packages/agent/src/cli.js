import dns from 'node:dns';
import net from 'node:net';
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily?.(false);
import dotenv from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load the repo-root .env, same as the server, no matter where npm runs this from.
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });
import { runDeliveryAgent, runOfflineScenario } from './index.js';

const command = process.argv[2] || '--demo';

if (command === '--demo') {
  const scenarios = [
    { name: 'Safe delivery', temperatureC: 5.2, checkpointMatched: true },
    { name: 'Temperature breach', temperatureC: 10.4, checkpointMatched: true },
    { name: 'Missing checkpoint', temperatureC: 5.2, checkpointMatched: false },
  ];
  console.log('AEROPAY · OFFLINE PREVIEW (no network calls or transactions)\n');
  for (const scenario of scenarios) {
    const result = runOfflineScenario(scenario);
    console.log(`${result.decision.toUpperCase()} · ${scenario.name}`);
    console.log(`  ${result.reason}\n`);
  }
} else if (command === '--check' || command === '--pay') {
  try {
    const result = await runDeliveryAgent(
      { temperatureC: 5.2, checkpointMatched: true },
      { authorize: command === '--pay' },
    );
    console.log(JSON.stringify(result, null, 2));
    if (result.decision === 'denied' || result.decision === 'needs_setup') process.exitCode = 1;
  } catch (error) {
    console.error(`AEROPAY ERROR · ${error.message}`);
    process.exitCode = 1;
  }
} else if (command === '--claim') {
  try {
    const secret = process.env.MERCHANT_SECRET?.trim() || '';
    if (!/^S[A-Z2-7]{55}$/.test(secret)) throw new Error('Set MERCHANT_SECRET (the merchant Testnet secret) in the .env file.');
    const { NoirAgentClient, keypairSigner, fromStroops } = await import('@noirx402/agent-sdk');
    const noir = new NoirAgentClient();
    const merchant = keypairSigner(secret);
    console.log(`Pending for merchant: ${fromStroops(await noir.getPendingBalance(merchant.publicKey))}`);
    const { hash } = await noir.claim({ merchant, token: process.env.ASSET_CONTRACT_ID.trim() });
    console.log(JSON.stringify({ claimed: true, transactionHash: hash, link: `https://stellar.expert/explorer/testnet/tx/${hash}` }, null, 2));
  } catch (error) {
    console.error(`AEROPAY ERROR · ${error.message}`);
    process.exitCode = 1;
  }
} else {
  console.error('Usage: npm run agent:demo | npm run agent:check | npm run agent:pay | npm run merchant:claim');
  process.exitCode = 2;
}
