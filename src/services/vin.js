function normalizeVin(vin) {
  return String(vin || '').toUpperCase().replace(/[^A-Z0-9*]/g, '');
}

function validateVin(vin) {
  const normalized = normalizeVin(vin);
  if (normalized.length !== 17) return { valid: false, error: 'VIN powinien mieć 17 znaków.' };
  if (/[IOQ]/.test(normalized)) return { valid: false, error: 'VIN nie może zawierać liter I, O ani Q.' };
  return { valid: true, vin: normalized };
}

async function decodeVin(vin) {
  const normalized = normalizeVin(vin);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(normalized)}?format=json`;
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'MojWarsztat/0.4' } });
    if (!response.ok) throw new Error(`Dekoder VIN zwrócił HTTP ${response.status}`);
    const payload = await response.json();
    const item = payload.Results?.[0] || {};
    return {
      vin: normalized,
      make: item.Make || '',
      model: item.Model || '',
      year: item.ModelYear ? Number(item.ModelYear) : null,
      engine: [item.DisplacementL ? `${item.DisplacementL} l` : '', item.EngineCylinders ? `${item.EngineCylinders} cyl.` : ''].filter(Boolean).join(', '),
      fuel: item.FuelTypePrimary || '',
      body: item.BodyClass || '',
      manufacturer: item.Manufacturer || '',
      errorCode: item.ErrorCode || '',
      errorText: item.ErrorText || ''
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { normalizeVin, validateVin, decodeVin };
