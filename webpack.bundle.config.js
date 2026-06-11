const path = require('path');

module.exports = {
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  target: 'web',

  entry: './src/core/page-entry.js',

  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'tracker-bundle.js',
    library: {
      name: '__elementTracker',
      type: 'umd',
    },
    globalObject: 'typeof window !== "undefined" ? window : globalThis',
  },

  optimization: {
    splitChunks: false,
    runtimeChunk: false,
  },

  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [
              [
                '@babel/preset-env',
                {
                  targets: { chrome: '108' },
                  modules: false,
                },
              ],
            ],
          },
        },
      },
    ],
  },

  resolve: {
    extensions: ['.js'],
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      'electron-log': path.resolve(__dirname, 'src/core/_page_stubs_/electron-log.js'),
    },
  },

  devtool: process.env.NODE_ENV === 'production' ? false : 'source-map',

  bail: true,
};
