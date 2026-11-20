// The owner's setup from config.json at the board root, read by app/server.js and the scripts.
// Get-Inbox.ps1 reads the same file.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const copies = raw.repoCopies || {};

// "BC25_*" becomes /^BC25_[\w.-]*$/i, so a repo field can only name a folder the pattern allows, never a path.
const glob = p => new RegExp('^' + String(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\w.-]*').replace(/\?/g, '[\\w.-]') + '$', 'i');

module.exports = {
  owner: String(raw.owner || 'Owner').trim(),
  projectsRoot: path.resolve(raw.projectsRoot || 'C:\\Projects'),
  edgeAppId: String(raw.edgeAppId || '').trim(),
  harvest: raw.harvest === true,
  objectIds: raw.objectIds === true,
  repoCopies: {
    enabled: copies.enabled === true,
    pattern: copies.pattern || '',
    match: copies.pattern ? glob(copies.pattern) : /^$/,
    workspace: copies.workspace || '',
  },
};
