# AeroPay

### Trust the delivery. Release the payment.

AeroPay is a policy-bound payment agent for cold-chain deliveries. The cargo owner funds escrow and sets the agent’s limits. At delivery, the agent checks the sensor evidence, destination checkpoint, and payment cap. A failed check keeps the funds locked.

**The live browser experience is an interactive simulation.** It needs no wallet or API key and does not send transactions. The separate command-line flow can read the real Stellar Testnet policy and, only when explicitly requested, submit an authorization.

The browser estimates its demo delivery payment as ₱80 plus ₱10 per straight-line kilometre, rounded to the nearest ₱10. This is not a road-route quote, currency conversion, or on-chain PHP payment; the Testnet CLI uses the asset contract configured in `.env`.

## Try it in under a minute

You need Node.js 22.23.4 or newer.

```bash
git clone https://github.com/elamparogovince-wq/agentic-payment.git
cd agentic-payment
npm start
```

Open [http://localhost:4173](http://localhost:4173), then select **Delivered safely**, **Temperature breach**, and **Over spend cap**. Watch the policy checks and decision trail change. The blocked scenarios demonstrate the safety behavior: no payment is submitted and escrow stays protected.

To see the same three cases in your terminal:

```bash
npm run agent:demo
```

## What makes it agentic

The agent evaluates evidence and policy at the point of delivery. Its authority is intentionally constrained: a device-specific policy names the authorized agent, allowed asset, per-payment maximum, and expiry. Noir’s Soroban contracts enforce the policy on-chain; application logic alone cannot raise the cap.

```text
Cold-chain tag ──> temperature + device hash ──┐
Delivery site ───> checkpoint evidence ────────┼──> policy check ──> authorize or refuse
Owner policy ────> agent + asset + amount cap ─┘                         │
                                                         escrow stays locked on refusal
```

### The 90-second pitch

“A delivery agent should be able to get paid without getting the owner’s wallet. AeroPay lets an owner pre-fund escrow and grant one device-linked agent a narrow policy. When a cold-chain shipment arrives, the agent checks the temperature, destination, allowed asset, and payment cap. If everything passes, it can authorize the payment. If the cargo warmed up or the amount is too high, the contract refuses and the funds stay protected. This demo shows both outcomes, and the Testnet CLI can check the deployed policy before anyone submits a payment.”

## Optional: real Testnet policy check

The web dashboard uses sample evidence. To query a real policy on Stellar Testnet, install the Noir SDK and set up a device that already has an active policy and escrow:

```bash
npm install --no-save @noirx402/agent-sdk
Copy-Item .env.example .env   # PowerShell
# cp .env.example .env        # macOS / Linux
```

Fill in `.env` with your Testnet values:

```env
DEVICE_HASH=64_character_sha256_hex_value
AGENT_SECRET=S_your_testnet_agent_secret
MERCHANT_ADDRESS=G_your_testnet_merchant_address
ASSET_CONTRACT_ID=C_your_stellar_testnet_token_contract
PAYMENT_AMOUNT=2.00
```

Start with the read-only check:

```bash
npm run agent:check
```

Only after you have reviewed the policy and intend to authorize the payment, run:

```bash
npm run agent:pay
```

`agent:pay` asks the Noir Testnet contract to authorize the payment from escrow; the merchant must separately claim pending funds. This is a real Testnet transaction. Testnet tokens have no real-world value. Never put a mainnet secret in `.env`.

## How to demo it

1. Start the app and introduce the cold-chain delivery problem. Use the map search or click the map to set pickup and delivery points.
2. Select **Delivered safely**. Point to the temperature, location, and spend-cap checks.
3. Select **Temperature breach**. Show that one failed reading changes the decision to deny and keeps escrow locked.
4. Select **Over spend cap**. Show that the agent cannot exceed the owner’s per-payment limit.
5. Explain that browser events are sample data; use `agent:check` to demonstrate a real, read-only policy query when a configured Testnet device is available.

## Project status

| Capability | Status |
| --- | --- |
| Interactive delivery and refusal demo | Simulated locally; no wallet needed |
| On-chain policy read and payment check | Implemented through `@noirx402/agent-sdk`; requires a configured Testnet device |
| On-chain authorization | Explicit `agent:pay` command; requires the agent secret and funded escrow |
| Physical sensor, GPS attestation, device signature verification | Not integrated; browser evidence is simulated |
| Production or mainnet use | Not ready |

We say “verified” in the interface to describe the scenario’s policy outcome. The browser does not authenticate physical sensor or GPS data. That trust boundary is a future integration point, not a feature this demo claims to have solved.

## Troubleshooting

- **The page will not start:** check `node --version`; use Node 22.23.4 or newer.
- **The Testnet SDK import fails:** run `npm install --no-save @noirx402/agent-sdk` from this folder.
- **No policy found:** the device must be registered and an agent policy must already exist on Stellar Testnet.
- **Payment refused:** inspect the contract’s returned reason, asset, amount cap, expiry, and escrow balance. A refusal does not submit a payment.
- **Keep secrets safe:** `.env` is ignored by Git. Do not commit it, paste secrets into an issue, or use a mainnet key.

## Stack

- Node.js built-in HTTP server (no build step for the demo)
- Plain HTML, CSS, and JavaScript
- Leaflet + OpenStreetMap for the interactive route picker; place lookup runs only when Search is submitted (no autocomplete), with at least one second between requests. Follow the [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/); its public endpoint is best-effort and is not a production geocoding service.
- [`@noirx402/agent-sdk`](https://www.npmjs.com/package/@noirx402/agent-sdk) for the optional Stellar Testnet policy check and authorization
- Noir device registry, agent registry, and payment escrow contracts

## Next steps for the team

1. Connect a real NFC tag or signed sensor feed and verify the source of each reading.
2. Add a merchant-facing claim screen and show the confirmed Testnet transaction in a Stellar explorer.
3. Record a short demo video showing one accepted and two refused deliveries.
4. Add automated tests for the policy scenarios and a live Testnet smoke test.

The project is a hackathon prototype, not audited payment software.
