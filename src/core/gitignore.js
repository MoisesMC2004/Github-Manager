const fs = require('fs');
const path = require('path');

const PRESETS = {
    env: {
        name: 'Environment & Secrets',
        header: '# Environment & Secrets',
        items: [
            { pattern: '.env', default: true },
            { pattern: '.env.local', default: true },
            { pattern: '.env.*.local', default: false },
            { pattern: '*.pem', default: true },
            { pattern: '*.key', default: true }
        ]
    },
    node: {
        name: 'Node / Web Frameworks',
        header: '# Node & Web Frameworks',
        triggers: ['package.json'],
        items: [
            { pattern: 'node_modules/', default: true },
            { pattern: 'dist/', default: true },
            { pattern: 'build/', default: false },
            { pattern: '.next/', default: false },
            { pattern: '.nuxt/', default: false },
            { pattern: '.output/', default: false },
            { pattern: '.turbo/', default: false },
            { pattern: '.cache/', default: false }
        ]
    },
    testing: {
        name: 'Testing & Coverage',
        header: '# Testing & Coverage',
        items: [
            { pattern: 'coverage/', default: true },
            { pattern: '.nyc_output/', default: false }
        ]
    },
    python: {
        name: 'Python Ecosystem',
        header: '# Python',
        triggers: ['requirements.txt', 'pyproject.toml', 'Pipfile'],
        items: [
            { pattern: '__pycache__/', default: true },
            { pattern: '*.py[cod]', default: true },
            { pattern: '.venv/', default: true },
            { pattern: 'venv/', default: false },
            { pattern: '.pytest_cache/', default: false },
            { pattern: '*.egg-info/', default: false }
        ]
    },
    rust: {
        name: 'Rust / Systems',
        header: '# Rust',
        triggers: ['Cargo.toml'],
        items: [
            { pattern: 'target/', default: true }
        ]
    },
    jvm: {
        name: 'Java / JVM',
        header: '# Java & JVM',
        triggers: ['pom.xml', 'build.gradle'],
        items: [
            { pattern: '.gradle/', default: true },
            { pattern: 'build/', default: false },
            { pattern: '*.class', default: true }
        ]
    },
    editors: {
        name: 'Editors & IDEs',
        header: '# Editors & IDEs',
        items: [
            { pattern: '.vscode/', default: false },
            { pattern: '.idea/', default: false },
            { pattern: '*.swp', default: false },
            { pattern: '*.swo', default: false }
        ]
    },
    logs: {
        name: 'Logs & Diagnostics',
        header: '# Logs & Diagnostics',
        items: [
            { pattern: '*.log', default: true },
            { pattern: 'npm-debug.log*', default: false },
            { pattern: 'yarn-debug.log*', default: false },
            { pattern: 'pnpm-debug.log*', default: false }
        ]
    },
    os: {
        name: 'OS Artifacts',
        header: '# Operating System Artifacts',
        items: [
            { pattern: '.DS_Store', default: true },
            { pattern: 'Thumbs.db', default: false },
            { pattern: 'Desktop.ini', default: false },
            { pattern: '*~', default: false }
        ]
    }
};

function matchesPattern(file, pattern) {
    const clean = pattern.replace(/\/$/, '');
    const escaped = clean
        .replace(/[.+^$(){}|\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i').test(file);
}

function getDetectedCategories(targetDir) {
    let entries = [];
    try { entries = fs.readdirSync(targetDir); } catch {}

    const isTriggered = key => {
        const cat = PRESETS[key];
        if (!cat) return false;
        const triggerMatch = cat.triggers && cat.triggers.some(t => entries.includes(t));
        const artifactMatch = cat.items.some(item => entries.some(file => matchesPattern(file, item.pattern)));
        return Boolean(triggerMatch || artifactMatch);
    };

    const hasSpecificEcosystem = isTriggered('node') || isTriggered('python') || isTriggered('rust') || isTriggered('jvm');

    const activeKeys = [
        'env',
        isTriggered('node') || !hasSpecificEcosystem ? 'node' : null,
        isTriggered('node') || isTriggered('testing') || !hasSpecificEcosystem ? 'testing' : null,
        isTriggered('python') || !hasSpecificEcosystem ? 'python' : null,
        isTriggered('rust') || !hasSpecificEcosystem ? 'rust' : null,
        isTriggered('jvm') || !hasSpecificEcosystem ? 'jvm' : null,
        'editors',
        'logs',
        'os'
    ].filter(Boolean);

    return activeKeys.map(key => {
        const cat = PRESETS[key];
        return {
            key,
            name: cat.name,
            header: cat.header,
            items: cat.items.map(item => {
                const detected = entries.some(file => matchesPattern(file, item.pattern));
                return {
                    pattern: item.pattern,
                    detected,
                    checked: detected || item.default
                };
            })
        };
    });
}

function buildGitignore(patterns) {
    const selected = new Set(patterns);
    const sections = [];

    for (const cat of Object.values(PRESETS)) {
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

module.exports = {
    PRESETS,
    matchesPattern,
    getDetectedCategories,
    buildGitignore,
    writeGitignore
};
