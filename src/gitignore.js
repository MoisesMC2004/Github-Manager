const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const inquirer = require('inquirer');
const { writeSectionHeader, writeStatusOK, writeStatusWarn, writeStatusInfo } = require('./ui');

const GITIGNORE_CATEGORIES = [
    {
        name: 'Environment Variables',
        key: 'env',
        items: [
            { pattern: '.env', desc: 'Main environment file' },
            { pattern: '.env.local', desc: 'Local overrides' },
            { pattern: '.env.*.local', desc: 'Mode-specific local configs' },
            { pattern: '*.env', desc: 'Any file ending in .env' }
        ]
    },
    {
        name: 'Dependencies & Packages',
        key: 'deps',
        items: [
            { pattern: 'node_modules/', desc: 'Node.js packages directory' },
            { pattern: 'jspm_packages/', desc: 'JSPM package manager' },
            { pattern: '.pnp/', desc: 'Yarn Plug\'n\'Play cache' },
            { pattern: '.pnp.js', desc: 'Yarn Plug\'n\'Play file' },
            { pattern: 'vendor/', desc: 'PHP Composer or Go vendor folder' },
            { pattern: '__pycache__/', desc: 'Python bytecode cache' },
            { pattern: '*.pyc', desc: 'Compiled Python files' },
            { pattern: '.venv/', desc: 'Python virtual environment' },
            { pattern: 'venv/', desc: 'Python virtual environment' },
            { pattern: 'target/', desc: 'Rust / Cargo / Java build directory' }
        ]
    },
    {
        name: 'Build & Distribution Outputs',
        key: 'build',
        items: [
            { pattern: 'dist/', desc: 'Distribution output directory' },
            { pattern: 'build/', desc: 'Generic compiled build folder' },
            { pattern: 'out/', desc: 'Next.js static export / generic output' },
            { pattern: '.next/', desc: 'Next.js build cache and output' },
            { pattern: '.nuxt/', desc: 'Nuxt.js build directory' },
            { pattern: '.output/', desc: 'Nitro / Nuxt server output' },
            { pattern: 'coverage/', desc: 'Code coverage reports' },
            { pattern: '.turbo/', desc: 'Turborepo cache' }
        ]
    },
    {
        name: 'IDEs & Editors',
        key: 'ide',
        items: [
            { pattern: '.vscode/', desc: 'Visual Studio Code workspace settings' },
            { pattern: '.idea/', desc: 'JetBrains IntelliJ / WebStorm config' },
            { pattern: '*.swp', desc: 'Vim swap files' },
            { pattern: '*.swo', desc: 'Vim swap files' }
        ]
    },
    {
        name: 'Operating System & Logs',
        key: 'system',
        items: [
            { pattern: '.DS_Store', desc: 'macOS folder metadata' },
            { pattern: 'Thumbs.db', desc: 'Windows image thumbnail cache' },
            { pattern: 'desktop.ini', desc: 'Windows folder layout file' },
            { pattern: '*.log', desc: 'Runtime and debug logs' },
            { pattern: 'npm-debug.log*', desc: 'npm crash logs' },
            { pattern: 'yarn-debug.log*', desc: 'Yarn crash logs' },
            { pattern: 'pnpm-debug.log*', desc: 'pnpm crash logs' }
        ]
    }
];

function analyzeProject(targetPath) {
    let entries = [];
    try {
        entries = fs.readdirSync(targetPath);
    } catch {
        entries = [];
    }

    const isNode = entries.includes('package.json') || entries.includes('node_modules');
    const isPython = entries.includes('requirements.txt') || entries.includes('pyproject.toml') || entries.includes('Pipfile');
    const isRust = entries.includes('Cargo.toml');

    const detectedPatterns = new Set();
    const recommendedPatterns = new Set();

    for (const cat of GITIGNORE_CATEGORIES) {
        for (const item of cat.items) {
            const clean = item.pattern.replace(/\/$/, '');
            let isDetected = false;

            if (item.pattern.includes('*')) {
                const prefix = item.pattern.split('*')[0];
                const suffix = item.pattern.split('*')[1] || '';
                isDetected = entries.some(e => {
                    if (prefix && suffix) return e.startsWith(prefix) && e.endsWith(suffix);
                    if (prefix) return e.startsWith(prefix);
                    if (suffix) return e.endsWith(suffix);
                    return false;
                });
            } else {
                isDetected = entries.includes(clean);
            }

            if (isDetected) {
                detectedPatterns.add(item.pattern);
                recommendedPatterns.add(item.pattern);
            }
        }
    }

    // Recommended defaults based on ecosystem
    if (isNode) {
        recommendedPatterns.add('node_modules/');
        recommendedPatterns.add('npm-debug.log*');
    }
    if (isPython) {
        recommendedPatterns.add('__pycache__/');
        recommendedPatterns.add('*.pyc');
        recommendedPatterns.add('.venv/');
    }
    if (isRust) {
        recommendedPatterns.add('target/');
    }

    // Universal standard recommendations
    recommendedPatterns.add('.env');
    recommendedPatterns.add('.DS_Store');
    recommendedPatterns.add('*.log');

    return {
        detectedPatterns,
        recommendedPatterns
    };
}

function buildGitignoreContent(selectedPatterns, customEntries = []) {
    const selectedSet = new Set(selectedPatterns);
    const sections = [];

    for (const cat of GITIGNORE_CATEGORIES) {
        const catItems = cat.items
            .filter(item => selectedSet.has(item.pattern))
            .map(item => item.pattern);

        if (catItems.length > 0) {
            sections.push(`# ${cat.name}\n${catItems.join('\n')}`);
        }
    }

    if (customEntries.length > 0) {
        sections.push(`# Custom Entries\n${customEntries.join('\n')}`);
    }

    return sections.join('\n\n') + '\n';
}

function printGitignorePreview(content) {
    console.log(chalk.gray('  ' + '─'.repeat(54)));
    const lines = content.trim().split('\n');
    for (const line of lines) {
        if (line.startsWith('#')) {
            console.log(chalk.bold.cyan(`  ${line}`));
        } else if (line.trim() === '') {
            console.log();
        } else {
            console.log(chalk.white(`  ${line}`));
        }
    }
    console.log(chalk.gray('  ' + '─'.repeat(54)));
    console.log();
}

async function promptGitignore(targetPath) {
    const { detectedPatterns, recommendedPatterns } = analyzeProject(targetPath);
    let customEntries = [];
    let currentSelected = Array.from(recommendedPatterns);

    console.log();
    writeSectionHeader('Standard .gitignore Generator', 'cyan');
    if (detectedPatterns.size > 0) {
        writeStatusInfo(`Detected ${detectedPatterns.size} standard artifact(s) present on disk.`);
    } else {
        writeStatusInfo('No existing artifacts detected on disk. Standard items pre-selected.');
    }
    console.log(chalk.gray('  Use arrow keys to navigate, Spacebar to toggle, Enter to confirm selection.\n'));

    let reviewing = false;

    while (true) {
        if (!reviewing) {
            const choices = [];

            for (const cat of GITIGNORE_CATEGORIES) {
                choices.push(new inquirer.Separator(chalk.bold.cyan(`── ${cat.name} ──`)));

                for (const item of cat.items) {
                    const isDetected = detectedPatterns.has(item.pattern);
                    const tag = isDetected ? chalk.green(' [Detected]') : '';
                    const desc = chalk.gray(`(${item.desc})`);
                    const isChecked = currentSelected.includes(item.pattern);

                    choices.push({
                        name: `${item.pattern.padEnd(18)} ${desc}${tag}`,
                        value: item.pattern,
                        checked: isChecked
                    });
                }
            }

            const { chosen } = await inquirer.prompt([{
                type: 'checkbox',
                name: 'chosen',
                message: 'Select patterns to include in .gitignore:',
                choices,
                pageSize: 18
            }]);

            currentSelected = chosen;
            reviewing = true;
        }

        const previewContent = buildGitignoreContent(currentSelected, customEntries);

        console.log();
        writeSectionHeader('.gitignore Preview Summary', 'yellow');
        printGitignorePreview(previewContent);

        const { action } = await inquirer.prompt([{
            type: 'list',
            name: 'action',
            message: 'Choose action for this .gitignore:',
            choices: [
                { name: chalk.green('✓ Save and apply .gitignore to project'), value: 'save' },
                { name: chalk.cyan('+ Add custom entry (file or glob pattern)...'), value: 'add_custom' },
                { name: chalk.yellow('✎ Modify pattern selections'), value: 'modify' },
                { name: chalk.red('✗ Cancel (skip creating .gitignore)'), value: 'cancel' }
            ]
        }]);

        if (action === 'save') {
            const gitignoreFile = path.join(targetPath, '.gitignore');
            fs.writeFileSync(gitignoreFile, previewContent, 'utf8');
            console.log();
            writeStatusOK(`Created .gitignore with ${currentSelected.length + customEntries.length} pattern(s).`);
            return true;
        }

        if (action === 'add_custom') {
            console.log();
            const { pattern } = await inquirer.prompt([{
                type: 'input',
                name: 'pattern',
                message: 'Enter custom file, folder, or glob pattern (e.g., config/keys.json or *.bak):',
                validate: v => v && v.trim().length > 0 ? true : 'Pattern cannot be empty'
            }]);

            const cleanPattern = pattern.trim();
            if (!customEntries.includes(cleanPattern)) {
                customEntries.push(cleanPattern);
                writeStatusOK(`Added custom pattern '${cleanPattern}'.`);
            } else {
                writeStatusWarn(`Pattern '${cleanPattern}' is already in custom entries.`);
            }
            continue;
        }

        if (action === 'modify') {
            reviewing = false;
            continue;
        }

        if (action === 'cancel') {
            console.log();
            writeStatusWarn('.gitignore creation skipped.');
            return false;
        }
    }
}

module.exports = {
    GITIGNORE_CATEGORIES,
    analyzeProject,
    buildGitignoreContent,
    promptGitignore
};
