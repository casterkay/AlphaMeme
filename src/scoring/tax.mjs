/** The limits a token's known taxes break, as security field names; an unknown tax breaks none. */
export function taxBreaches(buyTax, sellTax, { maxBuyTax, maxSellTax }) {
  return [buyTax !== null && buyTax > maxBuyTax && 'buyTax', sellTax !== null && sellTax > maxSellTax && 'sellTax'].filter(Boolean);
}
