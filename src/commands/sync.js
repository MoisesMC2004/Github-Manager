const path = require('path');
const fs = require('fs-extra');
const chalk = require('chalk');
const inquirer = require('inquirer');

const {
    clearHost,
    writeBanner,
    writeSectionHeader,
    writeStatusOK,
    writeStatusError,
    writeStatusWarn,
    writeStatusInfo,
    waitForKeypress
} = require('../ui');
const {
    runGit,
    hasMergeConflicts,
    getMergeConflictReason,
    getCurrentBranch,
    getBranches,
    stageAndCommit,
    resolvePushEnv
} = require('../git');
const { selectProjectForSync, addTrackedProject, getValidTrackedProjects } = require('../projects');
const { handleBranchOperations } = require('./branches');

async function quickSync() {
    clearHost();
    writeBanner('Quick Commit & Push', 'cyan');

    const localPath = await selectProjectForSync();
    if (!localPath) return;

    if (!fs.existsSync(localPath) || !fs.existsSync(path.join(localPath, '.git'))) {
        writeStatusError('The specified directory is not a valid Git repository.');
        await waitForKeypress();
        return;
    }

    // Guard 1: Detect merge, rebase, or cherry-pick conflicts
    if (hasMergeConflicts(localPath)) {
        const reason = getMergeConflictReason(localPath);
        console.log();
        writeStatusError(`Cannot sync repository: ${reason}`);
        console.log(chalk.yellow('  Please resolve all conflict markers and finish the active merge/rebase before syncing.'));
        await waitForKeypress();
        return;
    }

    // Guard 2: Detect detached HEAD state
    let head = getCurrentBranch(localPath);
    if (head.isDetached) {
        clearHost();
        writeBanner(`Detached HEAD: ${path.basename(localPath)}`, 'yellow');
        writeStatusWarn(`Repository is in detached HEAD state at commit ${head.commit || 'HEAD'}.`);
        console.log(chalk.gray('  You must checkout or create a branch to push commits upstream.\n'));

        const { detachedAction } = await inquirer.prompt([{
            type: 'list',
            name: 'detachedAction',
            message: 'Action for detached HEAD:',
            choices: [
                { name: '1. Create and checkout a new branch from this commit', value: 'create' },
                { name: '2. Switch to an existing branch', value: 'switch' },
                { name: '3. Cancel and return to main menu', value: 'cancel' }
            ]
        }]);

        if (detachedAction === 'cancel') return;

        if (detachedAction === 'create') {
            const { newBranch } = await inquirer.prompt([{
                type: 'input',
                name: 'newBranch',
                message: 'New branch name:',
                validate: v => v && v.trim() ? true : 'Required'
            }]);
            try {
                runGit(['checkout', '-b', newBranch.trim()], { cwd: localPath });
                writeStatusOK(`Created and switched to branch: ${newBranch.trim()}`);
                head = getCurrentBranch(localPath);
            } catch (err) {
                writeStatusError(`Failed to create branch: ${err.message}`);
                await waitForKeypress();
                return;
            }
        } else if (detachedAction === 'switch') {
            await handleBranchOperations(localPath);
            head = getCurrentBranch(localPath);
            if (head.isDetached) return;
        }
    }

    // Interactive Sync Screen Loop
    while (true) {
        clearHost();
        writeBanner(`Sync: ${path.basename(localPath)}`, 'cyan');
        console.log(chalk.gray(`  Folder:  ${localPath}`));

        head = getCurrentBranch(localPath);
        const branches = getBranches(localPath);
        const activeBranchInfo = branches.find(b => b.isCurrent) || { name: head.branch || 'main', status: 'untracked' };
        const badge = activeBranchInfo.status === 'synced' ? chalk.green('[Synced]') :
                      activeBranchInfo.status === 'ahead' ? chalk.cyan(`[Ahead ${activeBranchInfo.track}]`) :
                      activeBranchInfo.status === 'behind' ? chalk.yellow(`[Behind ${activeBranchInfo.track}]`) :
                      activeBranchInfo.status === 'diverged' ? chalk.magenta(`[Diverged ${activeBranchInfo.track}]`) :
                      chalk.gray('[Untracked]');

        console.log(chalk.gray(`  Branch:  ${chalk.bold.green(activeBranchInfo.name)} ${badge}\n`));

        const otherBranches = branches.filter(b => !b.isCurrent);
        const branchOptionLabel = otherBranches.length > 0
            ? '2. Branch Operations (Switch / Create / Merge / Delete)'
            : '2. Branch Operations (Create new branch)';

        const { syncOption } = await inquirer.prompt([{
            type: 'list',
            name: 'syncOption',
            message: 'Choose action:',
            choices: [
                { name: `1. Commit & Push current branch (${activeBranchInfo.name})`, value: 'push' },
                { name: branchOptionLabel, value: 'branches' },
                { name: '3. Cancel and return to main menu', value: 'cancel' }
            ]
        }]);

        if (syncOption === 'cancel') return;

        if (syncOption === 'branches') {
            await handleBranchOperations(localPath);
            continue; // Cleanly redraw Sync screen with updated active branch!
        }

        // Commit & Push flow
        const currentBranchName = activeBranchInfo.name || head.branch || 'main';

        try {
            let status = '';
            try {
                status = runGit(['status', '--short'], { cwd: localPath });
            } catch (e) {
                writeStatusError(`Could not read git status: ${e.message}`);
                await waitForKeypress();
                return;
            }

            if (status) {
                console.log(chalk.gray('\n  Changed files:'));
                status.split(/\r?\n/).forEach(l => console.log(`    ${chalk.yellow(l)}`));
                console.log();

                const { commitMsg } = await inquirer.prompt([{
                    type: 'input',
                    name: 'commitMsg',
                    message: 'Commit message:',
                    default: 'Update'
                }]);

                const finalMsg = (commitMsg && commitMsg.trim()) || 'Update';
                stageAndCommit(localPath, finalMsg);
                writeStatusOK('Changes committed.');
            } else {
                writeStatusInfo('Working tree is clean. Checking for unpushed commits...');
            }

            const { pushEnv, matchedUser, repoName } = resolvePushEnv(localPath);

            console.log(chalk.cyan(`  Pushing branch '${currentBranchName}' to remote...`));
            try {
                runGit(['push', '-u', 'origin', currentBranchName], { cwd: localPath, stdio: 'inherit', env: pushEnv });
            } catch (pushErr) {
                const errText = (pushErr.stderr || pushErr.message || '').toString();
                if (errText.includes('non-fast-forward') || errText.includes('fetch first')) {
                    writeStatusError('Remote has updates that you do not have locally (non-fast-forward).');
                    console.log(chalk.yellow('  Run "git pull --rebase" to incorporate remote changes before pushing.'));
                } else {
                    throw pushErr;
                }
            }

            console.log();
            writeStatusOK(`Sync complete for branch '${currentBranchName}'!`);

            addTrackedProject(localPath, repoName, matchedUser);
        } catch (err) {
            console.log();
            writeStatusError(`Sync failed: ${err.message || err}`);
        }

        await waitForKeypress();
        break;
    }
}

async function quickSyncAll() {
    clearHost();
    writeBanner('Quick Commit & Push to All', 'cyan');

    const projects = getValidTrackedProjects();
    if (!projects || projects.length === 0) {
        writeStatusWarn('No Git repositories found to sync.');
        await waitForKeypress();
        return;
    }

    console.log(chalk.gray(`  Found ${chalk.yellow(projects.length)} Git repository/repositories:\n`));
    projects.forEach((p, idx) => {
        const userTag = p.github_user ? chalk.cyan(`[${p.github_user}] `) : '';
        console.log(`    ${chalk.gray(`${idx + 1}.`)} ${userTag}${chalk.bold.white(p.name || path.basename(p.path))}  ${chalk.gray(p.path)}`);
    });
    console.log();

    const { commitMsg } = await inquirer.prompt([{
        type: 'input',
        name: 'commitMsg',
        message: 'Global commit message for all repositories:',
        default: 'Update'
    }]);

    const globalCommitMsg = (commitMsg && commitMsg.trim()) || 'Update';

    const { confirmAll } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirmAll',
        message: `Commit and push changes across all ${projects.length} repositories?`,
        default: true
    }]);

    if (!confirmAll) {
        console.log(chalk.gray('\n  ◈ Operation cancelled.'));
        await waitForKeypress();
        return;
    }

    const pushed = [];
    const clean = [];
    const failed = [];

    for (let i = 0; i < projects.length; i++) {
        const p = projects[i];
        const repoName = p.name || path.basename(p.path);
        console.log(chalk.cyan(`\n  ▸ [${i + 1}/${projects.length}] `) + chalk.bold.white(repoName));
        console.log(chalk.gray(`    Path: ${p.path}`));

        try {
            if (!fs.existsSync(p.path) || !fs.existsSync(path.join(p.path, '.git'))) {
                writeStatusWarn('Not a valid Git repository. Skipped.');
                clean.push({ ...p, status: 'invalid' });
                continue;
            }

            if (hasMergeConflicts(p.path)) {
                const reason = getMergeConflictReason(p.path);
                writeStatusError(`Skipped: ${reason}`);
                failed.push({ ...p, error: reason });
                continue;
            }

            const head = getCurrentBranch(p.path);
            if (head.isDetached) {
                writeStatusWarn(`Skipped: In detached HEAD state at ${head.commit || 'HEAD'}`);
                failed.push({ ...p, error: 'Detached HEAD state' });
                continue;
            }

            const currentBranch = head.branch || 'main';

            let status = '';
            try {
                status = runGit(['status', '--short'], { cwd: p.path });
            } catch (err) {
                throw new Error(`Failed to check repository status: ${err.message}`);
            }

            let committed = false;

            if (status) {
                const lines = status.split(/\r?\n/).filter(Boolean);
                console.log(chalk.gray(`    Changes detected (${lines.length} file(s)):`));
                lines.slice(0, 5).forEach(l => console.log(`      ${chalk.yellow(l)}`));
                if (lines.length > 5) {
                    console.log(chalk.gray(`      ... and ${lines.length - 5} more file(s)`));
                }

                stageAndCommit(p.path, globalCommitMsg);
                writeStatusOK('Changes committed.');
                committed = true;
            }

            let isAhead = false;
            let hasNoUpstream = false;
            try {
                const statusBranch = runGit(['status', '-sb'], { cwd: p.path });
                isAhead = statusBranch.includes('[ahead');
                hasNoUpstream = !statusBranch.includes('...');
            } catch {}

            if (!committed && !isAhead && !hasNoUpstream) {
                writeStatusOK('Clean & already up to date with remote (skipped push).');
                clean.push(p);
                continue;
            }

            const { pushEnv, matchedUser, repoName: resolvedRepo } = resolvePushEnv(p.path);

            console.log(chalk.cyan(`    Pushing branch '${currentBranch}' to remote...`));
            try {
                runGit(['push', '-u', 'origin', currentBranch], { cwd: p.path, stdio: 'pipe', env: pushEnv });
            } catch (pushErr) {
                const errText = (pushErr.stderr || pushErr.message || '').toString();
                throw new Error(errText.trim() || 'Push failed');
            }

            writeStatusOK(`Pushed branch '${currentBranch}' to remote successfully.`);
            pushed.push({ ...p, committed });

            addTrackedProject(p.path, resolvedRepo, matchedUser);
        } catch (err) {
            const errDetail = (err.stderr || err.message || String(err)).trim();
            writeStatusError(`Failed: ${errDetail}`);
            failed.push({ ...p, error: errDetail });
        }
    }

    console.log();
    writeSectionHeader('Sync All Summary', 'cyan');
    console.log(`    Total repositories:    ${chalk.white(projects.length)}`);
    console.log(`    Pushed successfully:   ${chalk.green(pushed.length)}`);
    console.log(`    Already up to date:    ${chalk.gray(clean.length)}`);
    if (failed.length > 0) {
        console.log(`    Failed:                ${chalk.red(failed.length)}`);
        failed.forEach(f => {
            console.log(chalk.red(`      ✗ ${f.name || path.basename(f.path)}: ${f.error}`));
        });
    }
    console.log();
    await waitForKeypress();
}

module.exports = { quickSync, quickSyncAll };
