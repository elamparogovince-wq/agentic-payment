# AeroPay

One-line pitch: A delivery agent releases a cold-chain carrier payout through Noir only when delivery evidence and the owner's Testnet policy pass; Velo confirms the shipper's booking payment.

**Live website:** https://aeropay-agentic-payment.onrender.com

**Pitch deck:** https://www.canva.com/d/vqv4hZEAL2UbFoB

**Demo video (2 min):** https://drive.google.com/file/d/18O6IElQNyncYYD1xLiOM6k-XQuArzwm4/view?usp=sharing

**Team:** Byte Me Daddy 

## Problem

Cold-chain deliveries can arrive late, warm, or at the wrong destination. A supplier still needs a clear way to get paid, while the cargo owner needs a payment that stops when the delivery conditions fail.

## Solution

AeroPay pairs a Velo Testnet booking checkout with a rule-based delivery agent. The server treats Velo's ledger-confirmed booking as the paid order, then checks the delivery evidence and the owner's Noir policy before authorizing the carrier payout from escrow. The cold-chain tag in this prototype is simulated in software, but its readings are cryptographically signed (Ed25519) and verified by the server before the agent may act on them. The temperature and destination values themselves are still sample data, not real sensor or GPS hardware.

## How the agentic payment works

1. The shipper creates and pays a Testnet booking checkout through Velo.
2. Velo confirms the PaymentIntent against Stellar ledger data and sends a signed webhook to AeroPay. The server verifies the signature and can also retrieve the PaymentIntent status from Velo.
3. A cold-chain tag (simulated here) signs each temperature and checkpoint reading with its Ed25519 key. The server checks the signature against its device registry, rejects stale timestamps (more than 5 minutes) and replayed nonces, and only then stores the reading. The browser never receives the Noir or Velo secrets.
4. A verified reading wakes the agent. There is no manual pay button: the agent runs by itself. It refuses immediately when the temperature is outside 2–8°C or the checkpoint is missing.
5. For a safe delivery, the agent holds the payout until Velo confirms the booking (a background check runs every 5 seconds, and the Velo webhook wakes it sooner), loads the device policy with the Noir SDK, and calls `checkPayment`.
6. Only when the Noir policy allows the configured Testnet amount does the agent call `authorizePayment`, which returns a Stellar Testnet transaction hash. The merchant then claims the pending balance with Noir's `claim` (from the page when `MERCHANT_SECRET` is set, or with `npm run merchant:claim`).
7. Every step is written to a database event log (Postgres when `DATABASE_URL` is set, otherwise SQLite) that the page shows as live agent activity. A shipment is settled at most once, and a server restart in the middle of a payment is recorded as unknown instead of paying twice.

The over-cap scenario asks Noir to check one stroop above the active policy maximum, then displays the refusal. That scenario never calls `authorizePayment`.

## Architecture

```mermaid
flowchart LR
  Shipper[Shipper] --> Web[apps/web · Vite UI]
  Web --> Server[apps/server · Express API]
  Server --> Velo[Velo SDK · Testnet checkout/status/webhook]
  Velo --> Ledger[(Stellar Testnet ledger)]
  Tag[Signed tag · Ed25519] --> Server
  Server --> DB[(Postgres or SQLite · events, readings, runs)]
  Server --> Agent[packages/agent · autonomous delivery agent]
  Agent --> Noir[Noir SDK · deployed Soroban contracts]
  Noir --> Ledger
  Shared[packages/shared · delivery policy] --> Agent
```

## Noir integration

- Noir SDK: `@noirx402/agent-sdk` `0.3.0`.
- Contracts: the SDK's deployed Stellar Testnet `device_registry`, `agent_registry`, and `payment_escrow` contracts.
- `getPolicy`, `checkPayment`, and `authorizePayment` are called by the server-side agent in [`packages/agent/src/index.js`](packages/agent/src/index.js).
- The agent key, device hash, merchant address, asset contract, and payout amount stay in the server `.env`.

## Velo integration

- Velo SDK: `@carts1024/velo-sdk` `0.1.0-alpha.4` (server-side Testnet SDK).
- Velo creates a separate fixed-amount shipment booking checkout in the configured Testnet asset. This is not the PHP route estimate and is not a PHP conversion.
- AeroPay retrieves PaymentIntent status from Velo and verifies `payment.succeeded` webhooks using the raw request body and `x-velo-signature` header.
- Checkout, status, and webhook code is in [`apps/server/src/server.js`](apps/server/src/server.js). The browser only calls AeroPay's API; it never sees the Velo API key or webhook secret.

This is a single-process hackathon prototype. Checkout mappings, recent webhook IDs, and agent decisions are held in memory and reset when the server restarts. Delivery readings and the selected checkpoint are user-provided sample values; they are not signed sensor or GPS attestations.

## Testnet proof

Noir carrier payout authorized on Stellar Testnet (2.00 XLM from card escrow, agent-signed after the delivery evidence and owner policy passed):

- Noir carrier payout: [d886db71…9876](https://stellar.expert/explorer/testnet/tx/d886db719ef3c7eaa165b26644e5c7bf820f50b256e63dceee4bc3dad6269876)
- Velo booking payment: [6ca6bfbd…132c](https://stellar.expert/explorer/testnet/tx/6ca6bfbde7f2ca3039b3c4c0efde2f52310de54d5da98a1f3764fd882a9f132c) (10.00 XLM Testnet checkout, confirmed by Velo)

## Repo structure

```text
apps/
  web/                  Vite frontend
  server/               Express API, signed telemetry, autonomous settlement loop, Postgres/SQLite store, tests
scripts/                derive-agent and device-sim (signed reading sender)
packages/
  agent/                rule-based agent and Noir SDK calls
  shared/               delivery policy shared by server and agent
docs/                   screenshots and demo materials
.env.example            empty environment-variable template
package.json            npm workspaces and root commands
README.md               judging and setup guide
```

## Run it locally

1. Install a supported Node.js version: `^22.23.4`, `^24.22.1`, or `>=26.12.1`.
2. Install the Noir Chrome extension and create/fund the required Stellar Testnet owner, agent, and merchant setup. Configure the deployed Noir policy and escrow.
3. From the repository root, run `npm install` to install workspace dependencies and create the npm lockfile.
4. Copy `.env.example` to `.env`; add the Velo Testnet API key and Noir Testnet values on the server. Never commit `.env`.
5. Run `npm test` to run the server tests (signatures, replay protection, settle-once, restart safety, merchant claim, persistence). Set `TEST_DATABASE_URL` to also run them against a real Postgres. Then run `npm run dev`. Open the Vite app at `http://localhost:5173`; the API runs at `http://localhost:4173`.
6. For production, set `APP_BASE_URL` to the deployed public HTTPS URL, configure Velo's webhook destination as `https://<your-host>/api/webhooks/velo`, build the web app with `npm run build`, and start the server with `npm run start --workspace @aeropay/server`.

Without credentials, the page displays setup status and the offline CLI remains available. It does not pretend a simulated result is a Testnet payment.

## Deploy on Render

This repository includes a Render Blueprint for a free Node web service. In Render, create a Blueprint from this repository and select the `aeropay-demo` branch. Render reads `render.yaml`, builds the Vite app, serves it from Express, and checks `/api/health`. Render supplies `RENDER_EXTERNAL_URL`, which the server uses for Velo's return links unless `APP_BASE_URL` is set explicitly.

After the first deploy, add the Velo and Noir values from your local `.env` to the service's Environment settings. Never commit those secrets. Configure the Velo webhook URL as `https://<your-render-host>/api/webhooks/velo`, then redeploy and complete a Testnet rehearsal. For data that survives deploys, create a free Postgres (for example on Neon) and set its connection string as `DATABASE_URL`; without it the server uses SQLite on Render's temporary disk. Free services can spin down after inactivity; open the site before presenting and allow the first request time to wake it.

## Environment variables

| Name | What it is | Where to get it |
| --- | --- | --- |
| `VELO_API_KEY` | Velo Testnet API key | Create a Testnet project in the Velo Build dashboard |
| `VELO_WEBHOOK_SECRET` | HMAC secret for Velo webhook verification | Velo project webhook settings |
| `VELO_CHECKOUT_ASSET` | Testnet checkout asset (default `USDC`) | Select an asset enabled for the Velo Testnet project |
| `VELO_CHECKOUT_AMOUNT` | Fixed booking checkout amount (default `1.00`) | Set a small Testnet-only demo amount |
| `APP_BASE_URL` | Public app URL used for Velo return links | Local default is `http://localhost:5173`; use HTTPS when deployed |
| `PORT` | Express server port | Hosting platform provides this in deployment |
| `DEVICE_HASH` | SHA-256 hash of the Noir device/card UID | Generate from the linked card UID; see Noir setup |
| `AGENT_SECRET` | Noir agent's Stellar Testnet secret key | Create/register the agent through Noir; keep server-side |
| `MERCHANT_ADDRESS` | Carrier's Stellar Testnet public address | Merchant's Testnet wallet |
| `ASSET_CONTRACT_ID` | Stellar Testnet asset contract used by Noir | The Testnet asset selected for the Noir policy |
| `PAYMENT_AMOUNT` | Noir payout amount in the configured asset | Set within the registered Noir policy cap |
| `PAYMENT_ASSET_LABEL` | Display label for the configured payout asset | For example, `XLM` or `USDC`; display only |
| `MERCHANT_SECRET` | Optional. Merchant's Testnet secret so the page and `npm run merchant:claim` can claim | The merchant Testnet wallet. Demo only; a real merchant signs with its own wallet |
| `DEVICE_SIM_SEED` | Seed for the simulated tag's Ed25519 key | Any long random string. Needed for `npm run device:send` |
| `DATABASE_URL` | Optional Postgres connection string so data survives Render deploys | Create a free Postgres on Neon or Supabase and copy its connection string |
| `DATA_DIR` | Folder for the SQLite database (default `./data`) | On Render, use a persistent disk or the data resets on deploy |

## Screenshots

**Home.** Route, cold-chain limit and agent payment cap.

![AeroPay home](docs/home.png)

**Velo booking paid.** The shipper's Testnet booking checkout is confirmed on Stellar.

![Velo checkout completed](docs/velo-paid.png)

**Agent run.** With the Velo booking confirmed, the agent checks the evidence and the Noir policy before paying 2.00 XLM.

![Agent checking delivery](docs/agent-checking.png)

**Payment refused.** A temperature breach (10.4°C, outside 2°–8°C) blocks the payout and the escrow stays locked.

![Temperature breach denied](docs/temperature-breach.png)

## What's next

- Replace the simulated tag with real signed hardware readings (GPS and temperature) registered in Noir's device registry.
- Let the merchant claim from its own connected wallet instead of a server-held Testnet key.
- Review and test thoroughly before any move to mainnet.

## Credits

- [Noir](https://github.com/noirx402/noir) and `@noirx402/agent-sdk` for constrained Testnet agent payments.
- [Velo](https://www.velo-build.dev) and `@carts1024/velo-sdk` for Testnet checkout, status retrieval, and signed webhooks.
- [Leaflet](https://leafletjs.com/) and [OpenStreetMap](https://www.openstreetmap.org/copyright) for the route picker.
