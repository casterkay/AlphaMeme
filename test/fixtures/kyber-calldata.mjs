// Real MetaAggregationRouterV2 calldata for hand-written KyberSwap stubs.
import { encodeFunctionData } from 'viem';
import { KYBER_ROUTER_SWAP_ABI } from '../../src/trading/router-abi.mjs';

const EXECUTOR = '0x' + '5e'.repeat(20);

/** A plain swap description; `changes` tampers with any field, `entry` picks the entry point. */
export function swapCalldata({ tokenIn, tokenOut, amountIn, recipient, minReturnAmount }, changes = {}, entry = 'swap') {
  const desc = { srcToken: tokenIn, dstToken: tokenOut, srcReceivers: [EXECUTOR], srcAmounts: [amountIn], feeReceivers: [], feeAmounts: [],
    dstReceiver: recipient, amount: amountIn, minReturnAmount, flags: 0n, permit: '0x', ...changes };
  if (entry === 'swapSimpleMode') return encodeFunctionData({ abi: KYBER_ROUTER_SWAP_ABI, functionName: 'swapSimpleMode', args: [EXECUTOR, desc, '0x', '0x'] });
  return encodeFunctionData({ abi: KYBER_ROUTER_SWAP_ABI, functionName: 'swap', args: [{ callTarget: EXECUTOR, approveTarget: EXECUTOR, targetData: '0x1234', desc, clientData: '0x' }] });
}
