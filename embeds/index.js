const fs = require('node:fs');
const path = require('node:path');

const types = new Map();
for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith('.js') && f !== 'index.js')) {
    const type = require(path.join(__dirname, file));
    if ('name' in type && Array.isArray(type.pages) && type.pages.length) { types.set(type.name, type); } else { console.error(`[WARNING] The embed type at ${file} is missing a required "name" or "pages" property.`); }
}

module.exports = { types };
