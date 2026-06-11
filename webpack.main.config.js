const path = require('path');

module.exports = {
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  target: 'electron-main',

  entry: {
    index: './src/main/index.js',
    preload: './src/main/preload.js',
  },

  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
  },

  externals: {
    playwright: 'commonjs playwright',
    'electron-log': 'commonjs electron-log',
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
                  targets: { electron: '41' },
                  modules: 'commonjs',
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
      '@security': path.resolve(__dirname, 'src/security'),
    },
  },

  devtool: process.env.NODE_ENV === 'production' ? false : 'source-map',

  bail: true,
};
