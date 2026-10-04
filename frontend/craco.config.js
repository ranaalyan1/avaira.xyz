// craco.config.js
const path = require("path");
require("dotenv").config();

// Check if we're in development/preview mode (not production build)
// Craco sets NODE_ENV=development for start, NODE_ENV=production for build
const isDevServer = process.env.NODE_ENV !== "production";

// Environment variable overrides
const config = {
  enableHealthCheck: process.env.ENABLE_HEALTH_CHECK === "true",
};

// Conditionally load health check modules only if enabled
let WebpackHealthPlugin;
let setupHealthEndpoints;
let healthPluginInstance;

if (config.enableHealthCheck) {
  WebpackHealthPlugin = require("./plugins/health-check/webpack-health-plugin");
  setupHealthEndpoints = require("./plugins/health-check/health-endpoints");
  healthPluginInstance = new WebpackHealthPlugin();
}

let webpackConfig = {
  eslint: {
    configure: {
      extends: ["plugin:react-hooks/recommended"],
      rules: {
        "react-hooks/rules-of-hooks": "error",
        "react-hooks/exhaustive-deps": "warn",
      },
    },
  },
  webpack: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
    configure: (webpackConfig) => {
      // Builds run on small boxes (the sandbox has ~4 GB RAM / 2 cores). CRA's
      // terser defaults fork a worker per core, and the Dynamic + viem graph is
      // big enough that the forked heap gets OOM-killed mid-minification. Run the
      // minimizer in-process instead: slower, but it stays inside the ceiling.
      const minimizer = (webpackConfig.optimization && webpackConfig.optimization.minimizer) || [];
      webpackConfig.optimization = {
        ...webpackConfig.optimization,
        minimizer: minimizer.map((plugin) => {
          const isTerser = plugin && plugin.constructor && /Terser/i.test(plugin.constructor.name);
          if (isTerser && plugin.options) {
            plugin.options.parallel = false;
            plugin.options.terserOptions = {
              ...(plugin.options.terserOptions || {}),
              compress: { ...((plugin.options.terserOptions || {}).compress || {}), passes: 1 },
            };
          }
          return plugin;
        }),
      };


      // Add ignored patterns to reduce watched directories
        webpackConfig.watchOptions = {
          ...webpackConfig.watchOptions,
          ignored: [
            '**/node_modules/**',
            '**/.git/**',
            '**/build/**',
            '**/dist/**',
            '**/coverage/**',
            '**/public/**',
        ],
      };

      // Add health check plugin to webpack if enabled
      if (config.enableHealthCheck && healthPluginInstance) {
        webpackConfig.plugins.push(healthPluginInstance);
      }
      return webpackConfig;
    },
  },
};

webpackConfig.devServer = (devServerConfig) => {
  // Normalize deprecated middleware hooks to setupMiddlewares so webpack-dev-server
  // does not emit onBeforeSetupMiddleware/onAfterSetupMiddleware warnings.
  const beforeHook = devServerConfig.onBeforeSetupMiddleware;
  const afterHook = devServerConfig.onAfterSetupMiddleware;
  if (beforeHook || afterHook) {
    const originalSetupMiddlewares = devServerConfig.setupMiddlewares;
    devServerConfig.setupMiddlewares = (middlewares, devServer) => {
      if (beforeHook) {
        beforeHook(devServer);
      }
      if (originalSetupMiddlewares) {
        middlewares = originalSetupMiddlewares(middlewares, devServer);
      }
      if (afterHook) {
        afterHook(devServer);
      }
      return middlewares;
    };
    delete devServerConfig.onBeforeSetupMiddleware;
    delete devServerConfig.onAfterSetupMiddleware;
  }

  // Add health check endpoints if enabled
  if (config.enableHealthCheck && setupHealthEndpoints && healthPluginInstance) {
    const originalSetupMiddlewares = devServerConfig.setupMiddlewares;

    devServerConfig.setupMiddlewares = (middlewares, devServer) => {
      // Call original setup if exists
      if (originalSetupMiddlewares) {
        middlewares = originalSetupMiddlewares(middlewares, devServer);
      }

      // Setup health endpoints
      setupHealthEndpoints(devServer, healthPluginInstance);

      return middlewares;
    };
  }

  return devServerConfig;
};

module.exports = webpackConfig;
