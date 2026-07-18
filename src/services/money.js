function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function lineTotals(item) {
  const net = round2(Number(item.quantity) * Number(item.unit_price_net));
  const vat = round2(net * Number(item.vat_rate) / 100);
  return { net, vat, gross: round2(net + vat) };
}

function sumItems(items) {
  return items.reduce((acc, item) => {
    const t = lineTotals(item);
    acc.net = round2(acc.net + t.net);
    acc.vat = round2(acc.vat + t.vat);
    acc.gross = round2(acc.gross + t.gross);
    return acc;
  }, { net: 0, vat: 0, gross: 0 });
}

function pln(value) {
  return new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(Number(value || 0));
}

module.exports = { round2, lineTotals, sumItems, pln };
