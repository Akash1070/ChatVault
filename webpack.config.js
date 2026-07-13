// webpack.config.js
// Two separate bundle targets:
//   1. extension  — Node.js CJS, runs in the VS Code extension host process
//   2. webview    — Browser ESM+React, runs inside the sandboxed WebviewPanel
//
// They share NO code at runtime. Communication is strictly via postMessage().
// This separation is required by VS Code's security model.

'use strict';

const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

const isProduction = process.argv.includes('--mode=production') || process.env.NODE_ENV === 'production';


/** @type {import('webpack').Configuration} */
const extensionConfig = {
  name: 'extension',
  target: 'node', // Extension host runs in Node.js, not the browser
  mode: 'none',   // Set by CLI flag (development|production)

  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2', // VS Code extension host expects CJS exports
    devtoolModuleFilenameTemplate: '../[resource-path]',
  },

  externals: {
    // VS Code module is provided by the host — never bundle it
    vscode: 'commonjs vscode',
    // better-sqlite3 uses native Node addons (.node files).
    // We must mark it external and copy the native binary separately.
    'better-sqlite3': 'commonjs better-sqlite3',
  },

  resolve: {
    extensions: ['.ts', '.js'],
  },

  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
            options: {
              configFile: 'tsconfig.json',
            },
          },
        ],
      },
    ],
  },

  plugins: [
    // Copy the better-sqlite3 prebuilt native binary into dist/
    // so the extension can require() it at runtime.
    new CopyPlugin({
      patterns: [
        {
          // Copy the .node binary for the current platform
          from: 'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
          to: 'better_sqlite3.node',
          noErrorOnMissing: true, // Will be present after npm install
        },
        {
          // Copy the media assets (icon, css) referenced in the webview HTML
          from: 'media',
          to: 'media',
          noErrorOnMissing: true,
        },
      ],
    }),
  ],

  devtool: isProduction ? false : 'nosources-source-map',

  infrastructureLogging: {
    level: 'log', // Enables webpack-problem-matchers in VS Code output
  },
};

/** @type {import('webpack').Configuration} */
const webviewConfig = {
  name: 'webview',
  target: 'web', // Webview runs in a sandboxed Chromium renderer
  mode: 'none',

  entry: './src/webview/index.tsx',
  output: {
    path: path.resolve(__dirname, 'dist', 'webview'),
    filename: 'webview.js',
  },

  externals: {
    // No vscode module available inside the webview sandbox.
    // The webview communicates through window.acquireVsCodeApi().
  },

  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
  },

  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
            options: {
              configFile: 'tsconfig.webview.json',
            },
          },
        ],
      },
      {
        // Inline CSS into the JS bundle for the webview.
        // VS Code's Content Security Policy restricts external stylesheets,
        // so we inject styles via a <style> tag using style-loader.
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },

  devtool: isProduction ? false : 'inline-source-map',

  plugins: [
    // Copy the webview HTML template into dist/webview/
    // The extension host references this file when creating the WebviewPanel.
    new CopyPlugin({
      patterns: [
        {
          from: 'src/webview/index.html',
          to: 'index.html',
        },
      ],
    }),
  ],
};

// Export both configs — webpack builds them in parallel
module.exports = [extensionConfig, webviewConfig];
