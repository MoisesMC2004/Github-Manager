const fs = require('fs');
const path = require('path');

const CATEGORIES = [
    {
        name: 'Environment Variables',
        header: '# Environment Variables',
        items: [
            { pattern: '.env', default: true },
            { pattern: '.env.local', default: true },
            { pattern: '.env.*.local', default: false }
        ]
    },
    {
        name: 'Dependencies & Packages',
        header: '# Dependencies',
        items: [
            { pattern: 'node_modules/', default: true },
            { pattern: 'vendor/', default: false },
            { pattern: '__pycache__/', default: false },
            { pattern: '.venv/', default: false }
        ]
    },
    {
        name: 'Build Outputs',
        header: '# Production Builds',
        items: [
            { pattern: 'dist/', default: true },
            { pattern: 'build/', default: false },
            { pattern: '.output/', default: false },
            { pattern: '.next/', default: false }
        ]
    },
    {
        name: 'IDEs & OS',
        header: '# IDEs & OS',
        items: [
            { pattern: '.DS_Store', default: true },
            { pattern: 'Thumbs.db', default: false },
            { pattern: '.vscode/', default: false },
            { pattern: '.idea/', default: false }
        ]
    },
    {
        name: 'Logs',
        header: '# Logs',
        items: [
            { pattern: '*.log', default: true },
            { pattern: 'npm-debug.log*', default: false }
        ]
    }
];

function matchesPattern(file, pattern) {
    const clean = pattern.replace(/\/$/, '');
    if (!pattern.includes('*')) return file === clean;
    const [prefix, suffix] = pattern.split('*');
    return file.startsWith(prefix) && (!suffix || (file.endsWith(suffix) && file.length >= prefix.length + suffix.length));
}

function getDetectedCategories(targetDir) {
    let entries = [];
    try { entries = fs.readdirSync(targetDir); } catch {}

    return CATEGORIES.map(cat => ({
        name: cat.name,
        header: cat.header,
        items: cat.items.map(item => {
            const detected = entries.some(file => matchesPattern(file, item.pattern));
            return { pattern: item.pattern, detected, checked: detected || item.default };
        })
    }));
}

function buildGitignore(patterns) {
    const selected = new Set(patterns);
    const sections = [];

    for (const cat of CATEGORIES) {
        const matched = cat.items.filter(i => selected.has(i.pattern)).map(i => i.pattern);
        matched.forEach(p => selected.delete(p));
        if (matched.length) sections.push(`${cat.header}\n${matched.join('\n')}`);
    }

    if (selected.size) sections.push(`# Custom Entries\n${Array.from(selected).join('\n')}`);
    return sections.length ? sections.join('\n\n') + '\n' : '';
}

function writeGitignore(targetDir, patterns) {
    const content = buildGitignore(patterns);
    fs.writeFileSync(path.join(targetDir, '.gitignore'), content, 'utf8');
    return content;
}

module.exports = { CATEGORIES, matchesPattern, getDetectedCategories, buildGitignore, writeGitignore };
