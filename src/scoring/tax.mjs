// Rates are fractions, so 0.05 - 0.03 lands a float hair above 0.02; a residue that small is not a breach.
const EPSILON = 1e-9;

/** The limits a token's known taxes break, as security field names; an unknown tax breaks none. */
export function taxBreaches(buyTax, sellTax, { maxBuyTax, maxSellTax, maxTaxAsymmetry }) {
  const over = (rate, limit) => rate !== null && rate - limit > EPSILON;
  return [
    over(buyTax, maxBuyTax) && 'buyTax',
    over(sellTax, maxSellTax) && 'sellTax',
    buyTax !== null && sellTax !== null && over(Math.abs(buyTax - sellTax), maxTaxAsymmetry) && 'taxDifference'
  ].filter(Boolean);
}
