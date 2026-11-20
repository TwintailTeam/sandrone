const fs = require('node:fs');
const path = require('node:path');

const platforms = new Map();
for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith('.js') && f !== 'index.js')) {
    const platform = require(path.join(__dirname, file));
    if ('name' in platform && typeof platform.fetch === 'function') { platforms.set(platform.name, platform); } else { console.error(`[WARNING] The linked role platform at ${file} is missing a required "name" or "fetch" property.`); }
}

const roles = [
    { key: 'github_commits', name: 'GitHub commits', description: 'Commits authored in the project repositories', type: 2, value: (stats) => stats.github?.commits ?? 0 },
    { key: 'github_merged_prs', name: 'Merged pull requests', description: 'Merged pull requests in the project repositories', type: 2, value: (stats) => stats.github?.mergedPrs ?? 0 },
    { key: 'donated', name: 'Donated', description: 'Total donated in whole USD across Open Collective, GitHub Sponsors and Ko-fi', type: 2, value: (stats) => Math.floor(((stats.opencollective ?? 0) + (stats.github?.sponsoredCents ?? 0) + (stats.kofi ?? 0)) / 100) },
];

module.exports = { platforms, roles };
