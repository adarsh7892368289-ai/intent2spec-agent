const path = require('path');
const fs = require('fs');

// Copies the canonical orchestration prompt into dist/mcp so ai-manager can pass
// it to Claude Code via --append-system-prompt-file in the packaged app.
class CopyOrchestrationPlugin {
  apply(compiler) {
    compiler.hooks.afterEmit.tap('CopyOrchestrationPlugin', () => {
      const src = path.resolve(__dirname, '.claude/skills/agentic-test-automation/orchestration.md');
      const destDir = path.resolve(__dirname, 'dist/mcp');
      try {
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(src, path.join(destDir, 'orchestration.md'));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[mcp build] could not copy orchestration.md:', err.message);
      }
    });
  }
}

// The MCP server is a standalone Node process that Claude Code spawns over stdio.
// It reuses the chrome-free playwright-manager + locator projection, runs its own
// Playwright, and never touches Electron. Bundled to a single dist/mcp/server.js.
module.exports = {
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  target: 'node',

  entry: './src/mcp/server.js',

  output: {
    path: path.resolve(__dirname, 'dist/mcp'),
    filename: 'server.js',
  },

  // Keep heavy / native deps external — resolved from node_modules at runtime.
  externals: {
    playwright: 'commonjs playwright',
    'electron-log': 'commonjs electron-log',
    '@modelcontextprotocol/sdk': 'commonjs @modelcontextprotocol/sdk',
    zod: 'commonjs zod',
  },

  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [['@babel/preset-env', { targets: { node: '18' }, modules: 'commonjs' }]],
          },
        },
      },
    ],
  },

  resolve: {
    extensions: ['.js'],
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@security': path.resolve(__dirname, 'src/security'),
    },
  },

  plugins: [new CopyOrchestrationPlugin()],

  devtool: process.env.NODE_ENV === 'production' ? false : 'source-map',
  bail: true,
};
