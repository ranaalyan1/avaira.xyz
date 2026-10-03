require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const privateKey = process.env.PRIVATE_KEY || process.env.PROTOCOL_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || "";
const hasValidPrivateKey = /^0x[a-fA-F0-9]{64}$/.test(privateKey);

module.exports = {
  solidity: {
    compilers: [{ version: "0.8.26", settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 }, viaIR: true } }],
  },
  networks: {
    fuji: {
      url: process.env.FUJI_RPC || "https://api.avax-test.network/ext/bc/C/rpc",
      chainId: 43113,
      accounts: hasValidPrivateKey ? [privateKey] : [],
      gasPrice: 25_000_000_000,
    },
    mainnet: {
      url: process.env.MAINNET_RPC || "https://api.avax.network/ext/bc/C/rpc",
      chainId: 43114,
      accounts: hasValidPrivateKey ? [privateKey] : [],
      gasPrice: 25_000_000_000,
    },
  },
  etherscan: {
    apiKey: {
      avalancheFujiTestnet: process.env.SNOWTRACE_API_KEY || "",
      avalanche: process.env.SNOWTRACE_API_KEY || "",
    },
    customChains: [
      {
        network: "avalancheFujiTestnet",
        chainId: 43113,
        urls: {
          apiURL: "https://api-testnet.snowtrace.io/api",
          browserURL: "https://testnet.snowtrace.io",
        },
      },
      {
        network: "avalanche",
        chainId: 43114,
        urls: {
          apiURL: "https://api.snowtrace.io/api",
          browserURL: "https://snowtrace.io",
        },
      },
    ],
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    coinmarketcap: process.env.CMC_API_KEY,
  },
};
