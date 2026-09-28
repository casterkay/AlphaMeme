// The two swap entry points of KyberSwap's MetaAggregationRouterV2
// (0x6131B5fae19EA4f9D964eAc0408E4408b66337b5), copied verbatim from the
// Etherscan-verified ABI as published in npm @gitmyabi/metaaggregationrouterv2@1.0.0
// (build etherscan-metaaggregationrouterv2-6131b5fa-1788246900243, integrity
// sha512-0YAJ/LvCglp2cRBmf9p1NPJ/yOS81v6P1TS5i+wvIhY0wb8j7PVi1Rz7YjcstlMumu+5FYHGmdTChty0stZtow==).
// Selectors: swap 0xe21fd0e9, swapSimpleMode 0x8af033fb.
const SWAP_DESCRIPTION = {
  components: [
    { internalType: 'contract IERC20', name: 'srcToken', type: 'address' },
    { internalType: 'contract IERC20', name: 'dstToken', type: 'address' },
    { internalType: 'address[]', name: 'srcReceivers', type: 'address[]' },
    { internalType: 'uint256[]', name: 'srcAmounts', type: 'uint256[]' },
    { internalType: 'address[]', name: 'feeReceivers', type: 'address[]' },
    { internalType: 'uint256[]', name: 'feeAmounts', type: 'uint256[]' },
    { internalType: 'address', name: 'dstReceiver', type: 'address' },
    { internalType: 'uint256', name: 'amount', type: 'uint256' },
    { internalType: 'uint256', name: 'minReturnAmount', type: 'uint256' },
    { internalType: 'uint256', name: 'flags', type: 'uint256' },
    { internalType: 'bytes', name: 'permit', type: 'bytes' }
  ],
  internalType: 'struct MetaAggregationRouterV2.SwapDescriptionV2',
  name: 'desc',
  type: 'tuple'
};

export const KYBER_ROUTER_SWAP_ABI = Object.freeze([
  {
    inputs: [{
      components: [
        { internalType: 'address', name: 'callTarget', type: 'address' },
        { internalType: 'address', name: 'approveTarget', type: 'address' },
        { internalType: 'bytes', name: 'targetData', type: 'bytes' },
        SWAP_DESCRIPTION,
        { internalType: 'bytes', name: 'clientData', type: 'bytes' }
      ],
      internalType: 'struct MetaAggregationRouterV2.SwapExecutionParams',
      name: 'execution',
      type: 'tuple'
    }],
    name: 'swap',
    outputs: [{ internalType: 'uint256', name: 'returnAmount', type: 'uint256' }, { internalType: 'uint256', name: 'gasUsed', type: 'uint256' }],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'contract IAggregationExecutor', name: 'caller', type: 'address' },
      SWAP_DESCRIPTION,
      { internalType: 'bytes', name: 'executorData', type: 'bytes' },
      { internalType: 'bytes', name: 'clientData', type: 'bytes' }
    ],
    name: 'swapSimpleMode',
    outputs: [{ internalType: 'uint256', name: 'returnAmount', type: 'uint256' }, { internalType: 'uint256', name: 'gasUsed', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function'
  }
]);
