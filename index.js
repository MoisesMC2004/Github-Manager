#!/usr/bin/env node
const inquirer = require('inquirer');
const chalk = require('chalk');

// ----------------------------------------------------------------
// CTRL+C HANDLING — Monkey-patch inquirer v8
// ----------------------------------------------------------------
const UI = require('inquirer/lib/ui/baseUI');

let inSubMenu = false;

UI.prototype.onForceClose = function () {
    this.close();
    const err = new Error('USER_CANCEL');
    err.name = 'UserCancelError';
    throw err;
};

process.on('uncaughtException', async (err) => {
    if (err.message === 'USER_CANCEL' || err.name === 'UserCancelError') {
        if (!inSubMenu) {
            console.log(chalk.cyan('\n\n  See you next time!\n'));
            process.exit(0);
        } else {
            console.log(chalk.gray('\n\n  ◈ Returning to main menu...\n'));
            inSubMenu = false;
            setTimeout(() => { main(); }, 300);
        }
    } else {
        console.error(chalk.red('\n  ✗ Error: ' + (err.message || err)));
        inSubMenu = false;
        setTimeout(() => { main(); }, 200);
    }
});

// ----------------------------------------------------------------
// MODULE IMPORTS
// ----------------------------------------------------------------
const { clearHost, writeBanner, writeStatusError, waitForKeypress } = require('./src/ui');
const { testGit } = require('./src/git');
const { managePreferences } = require('./src/profiles');
const { publishProject } = require('./src/commands/publish');
const { quickSync, quickSyncAll } = require('./src/commands/sync');
const { deleteProject } = require('./src/commands/delete');

// ----------------------------------------------------------------
// MAIN APPLICATION LOOP
// ----------------------------------------------------------------
async function main() {
    if (!testGit()) {
        clearHost();
        writeBanner('GitHub Manager', 'yellow');
        writeStatusError('Git is not installed or not in system PATH.');
        console.log(chalk.gray('  Please install Git and ensure it is in your system PATH (https://git-scm.com/).'));
        process.exit(1);
    }

    while (true) {
        inSubMenu = false;
        clearHost();
        writeBanner('GitHub Manager');

        try {
            const { option } = await inquirer.prompt([{
                type: 'list',
                name: 'option',
                message: 'Choose option:',
                choices: [
                    { name: '1. Publish New Project to GitHub', value: 'publish' },
                    { name: '2. Quick Commit & Push (Sync & Branches)', value: 'sync' },
                    { name: '3. Quick Commit & Push to All (Sync All)', value: 'sync_all' },
                    { name: '4. Delete GitHub Repository', value: 'delete' },
                    { name: '5. GitHub Profiles & Preferences', value: 'preferences' },
                    { name: '6. Exit', value: 'exit' }
                ]
            }]);

            if (option === 'exit') {
                console.log(chalk.cyan('\n  See you next time!\n'));
                process.exit(0);
            }

            inSubMenu = true;

            if (option === 'publish') {
                await publishProject();
            }

            if (option === 'sync') {
                await quickSync();
            }

            if (option === 'sync_all') {
                await quickSyncAll();
            }

            if (option === 'delete') {
                await deleteProject();
            }

            if (option === 'preferences') {
                await managePreferences();
            }
        } catch (err) {
            inSubMenu = false;
            if (err?.message !== 'USER_CANCEL' && err?.name !== 'UserCancelError') {
                writeStatusError(`Error: ${err.message || err}`);
                await waitForKeypress('Press enter...');
            }
        }
    }
}

main();
