import 'dotenv/config';
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
} else {
  console.error('Usage: npm run agent:demo | npm run agent:check | npm run agent:pay');
  process.exitCode = 2;
}
