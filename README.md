# AeroPay: Autonomous IoT Settlement Agent

AeroPay is an agentic payment system that utilizes **Velo SDK orchestration alongside Noir Testnet contracts** to create an autonomous IoT worker. The system automatically registers its decentralized identity, verifies real-world hardware status triggers, and securely releases payments from an escrow contract once all validation parameters are fully satisfied. By enabling automated financial settlement without human intervention, AeroPay pioneers a secure model for agentic commerce over decentralized infrastructure.

## 🚀 Key Features

*   **Decentralized Identity:** Automatically registers the AI Agent identity onto the Noir Testnet (`agent_registry`).
*   **Hardware Trigger Simulation:** Monitors real-world device updates and status validation triggers securely (`device_registry`).
*   **Automated Settlement:** Processes complex payment orchestration intents and triggers secure conditional contract execution (`payment_escrow`) via the Velo SDK.

## 🛠️ Contract Infrastructure (Noir Testnet)

The system is fully integrated with the latest deployed Noir Testnet contracts:
*   **Device Registry:** `CB4DPMGOA374JIB2ZVD4AHW5GJKQUYNOFGRYNOJ75EFH2KCJSMHOWIRA`
*   **Agent Registry:** `CBTDMJVCFQDIVWZBKAKZ2FQ3UEJNAAUFYCTJ3E4ON2MYXPLPSIXQ25JZ`
*   **Payment Escrow:** `CA5S4S7QGHJHJWVJBYL3CXZXZTNGKXMNZVDAEQNN7NUXFP4D7BYK7HIX`

## 💻 Tech Stack & Dependencies

*   **Velo SDK:** `@carts1024/velo-sdk` for workflow tracking and payment intent orchestration.
*   **Ethers.js:** `ethers` (v6) for direct JSON-RPC contract invocation and secure cryptographic wallet key signing.
*   **Environment Subsystem:** `dotenv` for sandboxed credential management.
*   **Runtime:** Node.js environment executed over Windows Subsystem for Linux (WSL).

## 🔧 Getting Started

1. **Clone the repository:**
   ```bash
   git clone <your-repository-url>
   cd agentic-payment
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   Create a `.env` file based on `.env.example`:
   ```env
   NOIR_TESTNET_RPC_URL="https://noir.network"
   AGENT_PRIVATE_KEY="your_private_key_here"
   VELO_API_KEY="your_velo_api_key_here"
   ```

4. **Run the Autonomous Agent:**
   ```bash
   node agent.js
   ```
