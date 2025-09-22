const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Cambia la directory della cache per Puppeteer
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};