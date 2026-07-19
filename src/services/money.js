function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function normalizeDiscount(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.min(100, Math.max(0, number));
}

function lineTotals(item) {
  const baseNet = round2(Number(item.quantity) * Number(item.unit_price_net));
  const discountPercent = normalizeDiscount(item.discount_percent);
  const net = round2(baseNet * (1 - discountPercent / 100));
  const discountNet = round2(baseNet - net);
  const vat = round2(net * Number(item.vat_rate) / 100);
  return { baseNet, discountPercent, discountNet, net, vat, gross: round2(net + vat) };
}

function sumItems(items, discountPercent = 0) {
  const base = items.reduce((acc, item) => {
    const t = lineTotals(item);
    acc.net = round2(acc.net + t.net);
    acc.vat = round2(acc.vat + t.vat);
    acc.gross = round2(acc.gross + t.gross);
    acc.baseNet = round2(acc.baseNet + t.baseNet);
    acc.lineDiscountNet = round2(acc.lineDiscountNet + t.discountNet);
    return acc;
  }, { net: 0, vat: 0, gross: 0, baseNet: 0, lineDiscountNet: 0 });
  const discount = normalizeDiscount(discountPercent);
  const factor = 1 - discount / 100;
  const discounted = {
    net: round2(base.net * factor),
    vat: round2(base.vat * factor),
    gross: round2(base.gross * factor)
  };
  return {
    ...discounted,
    baseNet: base.baseNet,
    baseVat: round2(base.vat + (base.net ? base.lineDiscountNet * (base.vat / base.net) : 0)),
    baseGross: round2(base.baseNet + base.vat),
    lineDiscountNet: base.lineDiscountNet,
    discountPercent: discount,
    discountNet: round2(base.net - discounted.net),
    discountVat: round2(base.vat - discounted.vat),
    discountGross: round2(base.gross - discounted.gross)
  };
}

function pln(value) {
  return new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(Number(value || 0));
}

module.exports = { round2, lineTotals, sumItems, pln, normalizeDiscount };
