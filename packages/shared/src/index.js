export const DELIVERY_POLICY = Object.freeze({
  minimumTemperatureC: 2,
  maximumTemperatureC: 8,
});

export function evaluateDeliveryEvidence({ temperatureC, checkpointMatched }) {
  const temperature = Number(temperatureC);
  const temperatureOk = Number.isFinite(temperature)
    && temperature >= DELIVERY_POLICY.minimumTemperatureC
    && temperature <= DELIVERY_POLICY.maximumTemperatureC;
  const checkpointOk = checkpointMatched === true;

  return {
    allowed: temperatureOk && checkpointOk,
    checks: {
      temperatureOk,
      checkpointOk,
    },
    reason: !temperatureOk
      ? `Temperature ${Number.isFinite(temperature) ? `${temperature.toFixed(1)}°C` : 'is missing'} is outside the ${DELIVERY_POLICY.minimumTemperatureC}–${DELIVERY_POLICY.maximumTemperatureC}°C policy range.`
      : !checkpointOk
        ? 'The delivery checkpoint is not confirmed.'
        : 'Delivery evidence meets the sample policy.',
  };
}
