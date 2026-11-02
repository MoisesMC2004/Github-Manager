const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const readline = require('readline');
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
            { pattern: 'vendor/', desc: 'PHP Composer or Go vendor directory' },
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
            { pattern: 'out/', desc: 'Next.js static export / output' },
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
            { pattern: '.idea/', desc: 'JetBrains IDE configuration' },
            { pattern: '*.swp', desc: 'Vim swap files' },
            { pattern: '*.swo', desc: 'Vim swap files' }
        ]
    },
    {
        name: 'Operating System & Logs',
        key: 'system',
        items: [
            { pattern: '.DS_Store', desc: 'macOS folder metadata' },
            { pattern: 'Thumbs.db', desc: 'Windows thumbnail cache' },
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

    const isNode = entries.includes('package.json') || entries.includes('node_modules') || entries.includes('pnpm-lock.yaml') || entries.includes('yarn.lock');
    const isPython = entries.includes('requirements.txt') || entries.includes('pyproject.toml') || entries.includes('Pipfile') || entries.includes('.venv') || entries.includes('venv');
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

    // Default ecosystem patterns
    if (isNode) {
        recommendedPatterns.add('.env');
        recommendedPatterns.add('node_modules/');
        recommendedPatterns.add('dist/');
        recommendedPatterns.add('.vscode/');
        recommendedPatterns.add('npm-debug.log*');
    }
    if (isPython) {
        recommendedPatterns.add('.env');
        recommendedPatterns.add('__pycache__/');
        recommendedPatterns.add('*.pyc');
        recommendedPatterns.add('.venv/');
        recommendedPatterns.add('.vscode/');
    }
    if (isRust) {
        recommendedPatterns.add('target/');
        recommendedPatterns.add('.vscode/');
    }

    // General defaults
    recommendedPatterns.add('.env');
    recommendedPatterns.add('.DS_Store');
    recommendedPatterns.add('*.log');

    const items = [];
    const seenPatterns = new Set();

    for (const cat of GITIGNORE_CATEGORIES) {
        for (const item of cat.items) {
            const isDetected = detectedPatterns.has(item.pattern);
            const isRecommended = recommendedPatterns.has(item.pattern);

            if ((isDetected || isRecommended) && !seenPatterns.has(item.pattern)) {
                items.push({
                    pattern: item.pattern,
                    category: cat.name,
                    isDetected,
                    checked: isDetected || (cat.key === 'env' && item.pattern === '.env') || (isNode && item.pattern === 'node_modules/')
                });
                seenPatterns.add(item.pattern);
            }
        }
    }

    return {
        detectedPatterns,
        recommendedItems: items
    };
}

function buildGitignoreContent(selectedItems) {
    const categoryOrder = [
        'Environment Variables',
        'Dependencies & Packages',
        'Build & Distribution Outputs',
        'IDEs & Editors',
        'Operating System & Logs',
        'Custom Entries'
    ];

    const grouped = {};
    for (const item of selectedItems) {
        const cat = item.category || 'Custom Entries';
        if (!grouped[cat]) grouped[cat] = [];
        if (!grouped[cat].includes(item.pattern)) {
            grouped[cat].push(item.pattern);
        }
    }

    const sections = [];
    for (const catName of categoryOrder) {
        if (grouped[catName] && grouped[catName].length > 0) {
            sections.push(`# ${catName}\n${grouped[catName].join('\n')}`);
            delete grouped[catName];
        }
    }

    for (const [catName, patterns] of Object.entries(grouped)) {
        if (patterns.length > 0) {
            sections.push(`# ${catName}\n${patterns.join('\n')}`);
        }
    }

    return sections.length > 0 ? sections.join('\n\n') + '\n' : '';
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

/**
 * Interactive menu to pick, customize, and generate .gitignore
 * Uses ANSI cursor controls and keypress events for a flicker-free UI.
 * @param {string} targetPath - Directory where .gitignore should be created
 * @returns {Promise<boolean>} - true if saved, false if skipped/cancelled
 */
async function promptGitignore(targetPath) {
    const { detectedPatterns, recommendedItems } = analyzeProject(targetPath);
    const items = [...recommendedItems];

    console.log();
    writeSectionHeader('Standard .gitignore Generator', 'cyan');
    if (detectedPatterns.size > 0) {
        writeStatusInfo(`Detected ${detectedPatterns.size} standard artifact(s) present on disk.`);
    } else {
        writeStatusInfo('No existing artifacts detected on disk. Standard recommendations pre-selected.');
    }
    console.log(chalk.gray('  Use Arrow Keys to navigate, Spacebar to toggle, Enter to confirm/execute.\n'));

    // Menu options: items[0..N-1], then actions at bottom
    // actions:
    //   N     : Add custom entry
    //   N + 1 : Save and generate
    //   N + 2 : Cancel
    let cursor = 0;
    let lastRenderLineCount = 0;

    const actionLabels = [
        { key: 'custom', label: '+ Add custom entry...' },
        { key: 'save',   label: '✔ Save and generate .gitignore' },
        { key: 'cancel', label: '✖ Cancel (skip .gitignore)' }
    ];

    function calculateWindow(activeCursor, totalItemCount, maxVisible) {
        if (totalItemCount <= maxVisible) {
            return { start: 0, end: totalItemCount };
        }
        const half = Math.floor(maxVisible / 2);
        let start = Math.max(0, activeCursor - half);
        let end = start + maxVisible;
        if (end > totalItemCount) {
            end = totalItemCount;
            start = end - maxVisible;
        }
        return { start, end };
    }

    function render() {
        const maxVisibleItems = Math.max(6, Math.min(10, (process.stdout.rows || 24) - 10));
        const totalItems = items.length;
        const totalRows = totalItems + actionLabels.length;

        // Erase previous render
        if (lastRenderLineCount > 0) {
            readline.cursorTo(process.stdout, 0);
            process.stdout.write(`\x1B[${lastRenderLineCount}A\x1B[0J`);
        }

        const lines = [];

        // Determine scrolling window for item rows
        const itemCursor = cursor < totalItems ? cursor : totalItems - 1;
        const { start, end } = calculateWindow(itemCursor, totalItems, maxVisibleItems);

        if (start > 0) {
            lines.push(chalk.gray(`     ↑ ${start} more pattern(s) above...`));
        }

        for (let i = start; i < end; i++) {
            const item = items[i];
            const isFocused = i === cursor;
            const prefix = isFocused ? chalk.cyan('> ') : '  ';
            const check = item.checked ? chalk.green('[x]') : chalk.gray('[ ]');
            const patternStr = (isFocused ? chalk.bold.white(item.pattern) : chalk.white(item.pattern)).padEnd(22);
            const categoryStr = chalk.gray(`(${item.category})`);
            const detectedStr = item.isDetected ? chalk.green(' [Detected]') : '';

            lines.push(`${prefix} ${check} ${patternStr} ${categoryStr}${detectedStr}`);
        }

        if (end < totalItems) {
            lines.push(chalk.gray(`     ↓ ${totalItems - end} more pattern(s) below...`));
        }

        lines.push(chalk.gray('  ' + '─'.repeat(54)));

        // Action rows
        for (let a = 0; a < actionLabels.length; a++) {
            const actionIdx = totalItems + a;
            const isFocused = actionIdx === cursor;
            const prefix = isFocused ? chalk.cyan('> ') : '  ';
            const act = actionLabels[a];

            let coloredLabel;
            if (act.key === 'custom') {
                coloredLabel = isFocused ? chalk.bold.cyan(act.label) : chalk.cyan(act.label);
            } else if (act.key === 'save') {
                coloredLabel = isFocused ? chalk.bold.green(act.label) : chalk.green(act.label);
            } else {
                coloredLabel = isFocused ? chalk.bold.red(act.label) : chalk.gray(act.label);
            }

            lines.push(`${prefix}   ${coloredLabel}`);
        }

        for (const line of lines) {
            process.stdout.write(line + '\n');
        }

        lastRenderLineCount = lines.length;
    }

    return new Promise((resolve, reject) => {
        readline.emitKeypressEvents(process.stdin);
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdout.write('\x1B[?25l'); // Hide cursor

        render();

        const onKeypress = async (str, key) => {
            if (!key) return;

            // Handle Ctrl+C
            if (key.ctrl && key.name === 'c') {
                cleanup();
                const err = new Error('USER_CANCEL');
                err.name = 'UserCancelError';
                reject(err);
                return;
            }

            const totalRows = items.length + actionLabels.length;

            if (key.name === 'up') {
                cursor = (cursor - 1 + totalRows) % totalRows;
                render();
                return;
            }

            if (key.name === 'down') {
                cursor = (cursor + 1) % totalRows;
                render();
                return;
            }

            if (key.name === 'space' || key.name === 'return') {
                // If cursor is on a checkbox item
                if (cursor < items.length) {
                    items[cursor].checked = !items[cursor].checked;
                    render();
                    return;
                }

                // If cursor is on an action row
                const actionIndex = cursor - items.length;
                const action = actionLabels[actionIndex]?.key;

                if (action === 'custom') {
                    // Temporarily pause raw keypress mode to ask for text input
                    pausePrompt();

                    console.log();
                    const { customPattern } = await inquirer.prompt([{
                        type: 'input',
                        name: 'customPattern',
                        message: 'Enter custom file, folder, or glob pattern (e.g. config/keys.json or *.tmp):',
                        validate: v => v && v.trim().length > 0 ? true : 'Pattern cannot be empty'
                    }]);

                    const clean = customPattern.trim();
                    const existingIdx = items.findIndex(i => i.pattern.toLowerCase() === clean.toLowerCase());
                    if (existingIdx >= 0) {
                        items[existingIdx].checked = true;
                        cursor = existingIdx;
                    } else {
                        items.push({
                            pattern: clean,
                            category: 'Custom Entries',
                            isDetected: false,
                            checked: true,
                            isCustom: true
                        });
                        cursor = items.length - 1;
                    }

                    console.log();
                    resumePrompt();
                    render();
                    return;
                }

                if (action === 'save') {
                    cleanup();

                    const selectedItems = items.filter(i => i.checked);
                    const content = buildGitignoreContent(selectedItems);

                    console.log();
                    writeSectionHeader('.gitignore Preview Summary', 'yellow');
                    printGitignorePreview(content);

                    const gitignoreFile = path.join(targetPath, '.gitignore');
                    fs.writeFileSync(gitignoreFile, content, 'utf8');

                    writeStatusOK(`Created .gitignore with ${selectedItems.length} pattern(s).`);
                    resolve(true);
                    return;
                }

                if (action === 'cancel') {
                    cleanup();
                    console.log();
                    writeStatusWarn('.gitignore creation skipped.');
                    resolve(false);
                    return;
                }
            }
        };

        function pausePrompt() {
            process.stdin.removeListener('keypress', onKeypress);
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
            }
            process.stdout.write('\x1B[?25h'); // Show cursor
            lastRenderLineCount = 0;
        }

        function resumePrompt() {
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(true);
            }
            process.stdout.write('\x1B[?25l'); // Hide cursor
            process.stdin.on('keypress', onKeypress);
        }

        function cleanup() {
            process.stdin.removeListener('keypress', onKeypress);
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
            }
            process.stdout.write('\x1B[?25h'); // Show cursor
        }

        process.stdin.on('keypress', onKeypress);
    });
}

module.exports = {
    GITIGNORE_CATEGORIES,
    analyzeProject,
    buildGitignoreContent,
    promptGitignore
};
