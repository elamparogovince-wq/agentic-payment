import { evaluateDeliveryEvidence } from '../../shared/src/index.js';

const REQUIRED_NOIR_ENV = [
  'DEVICE_HASH',
  'AGENT_SECRET',
  'MERCHANT_ADDRESS',
  'ASSET_CONTRACT_ID',
  'PAYMENT_AMOUNT',
];

export function noirReadiness(env = process.env) {
  const deviceHash = env.DEVICE_HASH?.trim().replace(/^0x/i, '') || '';
  const paymentAmount = env.PAYMENT_AMOUNT?.trim() || '';
  const valid = {
    DEVICE_HASH: /^[a-f\d]{64}$/i.test(deviceHash),
    AGENT_SECRET: /^S[A-Z2-7]{55}$/.test(env.AGENT_SECRET?.trim() || ''),
    MERCHANT_ADDRESS: /^G[A-Z2-7]{55}$/.test(env.MERCHANT_ADDRESS?.trim() || ''),
    ASSET_CONTRACT_ID: /^C[A-Z2-7]{55}$/.test(env.ASSET_CONTRACT_ID?.trim() || ''),
    PAYMENT_AMOUNT: /^\d+(\.\d{1,7})?$/.test(paymentAmount) && Number(paymentAmount) > 0,
  };
  return {
    ready: REQUIRED_NOIR_ENV.every((name) => valid[name]),
    missing: REQUIRED_NOIR_ENV.filter((name) => !valid[name]),
  };
}

export async function runDeliveryAgent(input, { authorize = false, env = process.env } = {}) {
  const scenario = input.scenario || 'success';
  if (!['success', 'breach', 'overcap'].includes(scenario)) {
    throw new Error('scenario must be success, breach, or overcap.');
  }
  const evidence = evaluateDeliveryEvidence(input);
  if (!evidence.allowed) {
    return {
      decision: 'denied',
      mode: 'rule-based-agent',
      paymentSubmitted: false,
      evidence,
      reason: evidence.reason,
    };
  }

  const readiness = noirReadiness(env);
  if (!readiness.ready) {
    return {
      decision: 'needs_setup',
      mode: 'rule-based-agent',
      paymentSubmitted: false,
      evidence,
      missing: readiness.missing,
      reason: 'Delivery evidence passes, but the Noir Testnet agent is not configured.',
    };
  }

  const deviceHash = env.DEVICE_HASH.trim().replace(/^0x/i, '');
  if (!/^[a-f\d]{64}$/i.test(deviceHash)) {
    throw new Error('DEVICE_HASH must be a 64-character SHA-256 hex value.');
  }
  if (!/^G[A-Z2-7]{55}$/.test(env.MERCHANT_ADDRESS.trim())) {
    throw new Error('MERCHANT_ADDRESS must be a Stellar public address starting with G.');
  }

  const { NoirAgentClient, keypairSigner, toStroops } = await import('@noirx402/agent-sdk');
  const noir = new NoirAgentClient(); // Uses the deployed Noir Stellar Testnet contracts.
  const agent = keypairSigner(env.AGENT_SECRET.trim());
  const asset = env.ASSET_CONTRACT_ID.trim();
  const policy = await noir.getPolicy(deviceHash);
  if (!policy) {
    return {
      decision: 'denied',
      mode: 'noir-testnet',
      paymentSubmitted: false,
      evidence,
      reason: 'No active Noir policy is registered for this delivery device.',
    };
  }

  const amount = scenario === 'overcap'
    ? BigInt(policy.maxAmount) + 1n
    : toStroops(env.PAYMENT_AMOUNT.trim());

  const check = await noir.checkPayment({
    deviceHash,
    agent: agent.publicKey,
    asset,
    amount,
  });
  if (!check.ok) {
    return {
      decision: 'denied',
      mode: 'noir-testnet',
      paymentSubmitted: false,
      evidence,
      policyCheck: check,
      reason: `Noir refused the payment: ${check.reason}.`,
    };
  }

  if (scenario === 'overcap') {
    return {
      decision: 'denied',
      mode: 'noir-testnet',
      paymentSubmitted: false,
      evidence,
      policyCheck: check,
      reason: 'The over-cap scenario is configured as a refusal check. No authorization was sent.',
    };
  }

  if (!authorize) {
    return {
      decision: 'approved',
      mode: 'noir-testnet',
      paymentSubmitted: false,
      evidence,
      policyCheck: check,
      amount: env.PAYMENT_AMOUNT.trim(),
      merchant: env.MERCHANT_ADDRESS.trim(),
      reason: 'Delivery evidence and Noir policy both pass. No transaction was submitted.',
    };
  }

  const result = await noir.authorizePayment({
    agent,
    deviceHash,
    merchant: env.MERCHANT_ADDRESS.trim(),
    asset,
    amount,
  });

  return {
    decision: 'authorized',
    mode: 'noir-testnet',
    paymentSubmitted: true,
    evidence,
    policyCheck: check,
    amount: env.PAYMENT_AMOUNT.trim(),
    merchant: env.MERCHANT_ADDRESS.trim(),
    transactionHash: result.hash,
    reason: 'The agent authorized the payment on Stellar Testnet. The merchant must claim the pending balance.',
  };
}

export function runOfflineScenario(input) {
  const evidence = evaluateDeliveryEvidence(input);
  return {
    decision: evidence.allowed ? 'would_allow' : 'denied',
    mode: 'simulation',
    paymentSubmitted: false,
    evidence,
    reason: evidence.allowed
      ? 'Sample evidence passes. This offline preview sends no transaction.'
      : evidence.reason,
  };
}
