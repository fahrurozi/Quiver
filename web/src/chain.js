// The chain the dashboard is currently showing. Filled from /api/overview (status.chain) on every
// poll, read by non-React helpers (fmt.js: explorer links) and components.
//
// One dashboard = one chain at a time: the server picks the chain from the
// lpcopy_chain cookie (see ChainSwitcher), so every /api/* already belongs to this chain.
const DEFAULT = {
  key: 'robinhood', label: 'Robinhood Chain', chainId: 4663, nativeSymbol: 'ETH',
  usdgSymbol: 'USDG', wethSymbol: 'WETH', explorer: 'https://robinhoodchain.blockscout.com',
  dexscreener: 'robinhood', geckoterminal: 'robinhood', gmgn: 'robinhood', uniswap: 'robinhood', venues: ['v4', 'v3'], verified: true,
};
let current = { ...DEFAULT };

export const setChain = (info) => { if (info?.key) current = { ...DEFAULT, ...info }; };
export const chainInfo = () => current;
// Symbols valued through the native price (ETH/WETH on Robinhood, BNB/WBNB on BSC).
export const isEthLike = (sym) => sym === current.nativeSymbol || sym === current.wethSymbol;
// Small icon per chain in the picker & header (public/*.png|jpg, each chain's official logo).
export const CHAIN_ICON = {
  robinhood: '/robinhood-chain.jpg',
  bsc: '/bnb-chain.png',
};
// Name of this chain's block explorer — used as the wallet button label (fmt.js/ui.jsx),
// because "Blockscout" and "BscScan" are better known than the host name.
export const EXPLORER_NAME = {
  robinhood: 'Blockscout',
  bsc: 'BscScan',
};
// This chain's Etherscan, if any — its tx/token index differs from Blockscout, so
// the two are useful side by side. On BSC the explorer IS already BscScan (Etherscan family),
// so there is no second entry: one button for one site.
export const ETHERSCAN = {
  robinhood: 'https://robin.etherscan.io',
};
