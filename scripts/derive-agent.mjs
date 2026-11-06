// Gets the card-agent key that the Noir extension derived from your wallet's
// recovery phrase (SEP-5 / SLIP-10 ed25519, path m/44'/148'/0'/<n>').
// Usage: node scripts/derive-agent.mjs        (it asks for the phrase; nothing is saved)
import { Keypair } from '@stellar/stellar-sdk';
import { createHmac, pbkdf2Sync } from 'node:crypto';
import readline from 'node:readline/promises';

const H = 0x80000000;
function derive(seed, path) {
  let I = createHmac('sha512', 'ed25519 seed').update(seed).digest();
  let key = I.subarray(0, 32), chain = I.subarray(32);
  for (const seg of path) {
    const d = Buffer.alloc(37); key.copy(d, 1); d.writeUInt32BE((seg + H) >>> 0, 33);
    I = createHmac('sha512', chain).update(d).digest();
    key = I.subarray(0, 32); chain = I.subarray(32);
  }
  return Keypair.fromRawEd25519Seed(Buffer.from(key));
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lines = [];
process.stdout.write('Recovery phrase (Testnet wallet only): ');
for await (const line of rl) {
  lines.push(line);
  if (lines.length === 1) process.stdout.write('Address to look for (G...): ');
  if (lines.length === 2) break;
}
rl.close();
const phrase = (lines[0] || '').trim().toLowerCase().split(/\s+/).join(' ');
const want = (lines[1] || '').trim();
const seed = pbkdf2Sync(phrase.normalize('NFKD'), 'mnemonic', 2048, 64, 'sha512');
console.log('\nWallet (owner):', derive(seed, [44, 148, 0]).publicKey());
for (let i = 1; i <= 64; i++) {
  const kp = derive(seed, [44, 148, 0, i]);
  if (kp.publicKey() === want) {
    console.log(`\nFOUND agent at index ${i}\nAGENT_SECRET=${kp.secret()}`);
    process.exit(0);
  }
}
console.log('\nFirst agent addresses from this phrase (compare with the extension):');
for (let i = 1; i <= 5; i++) console.log(`  #${i}`, derive(seed, [44, 148, 0, i]).publicKey());
console.log('\nAgent address not found in this phrase (indexes 1-64). Check the phrase and the address.');
