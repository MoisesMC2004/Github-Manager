const path = require('path');
const chalk = require('chalk');
const inquirer = require('inquirer');

const {
    clearHost,
    writeBanner,
    writeSectionHeader,
    writeStatusOK,
    writeStatusError,
    writeStatusWarn,
    waitForKeypress
} = require('../ui');
const {
    runGit,
    getBranches,
    getCurrentBranch,
    getDefaultBranch,
    isDirty,
    stashPush,
    stashPop,
    mergeBranch,
    deleteBranch,
    resolvePushEnv
} = require('../git');

async function handleBranchOperations(localPath) {
    let feedback = null;

    while (true) {
        clearHost();
        writeBanner(`Branch Manager: ${path.basename(localPath)}`, 'cyan');

        if (feedback) {
            if (feedback.type === 'success') writeStatusOK(feedback.msg);
            else if (feedback.type === 'error') writeStatusError(feedback.msg);
            else if (feedback.type === 'warn') writeStatusWarn(feedback.msg);
            console.log();
            feedback = null;
        }

        const branches = getBranches(localPath);
        const head = getCurrentBranch(localPath);
        const defaultBranch = getDefaultBranch(localPath);

        const currentBranch = branches.find(b => b.isCurrent);
        const branchName = head.branch || (currentBranch ? currentBranch.name : 'detached');
        const badge = currentBranch
            ? (currentBranch.status === 'synced' ? chalk.green('[Synced]') :
               currentBranch.status === 'ahead' ? chalk.cyan(`[Ahead ${currentBranch.track}]`) :
               currentBranch.status === 'behind' ? chalk.yellow(`[Behind ${currentBranch.track}]`) :
               currentBranch.status === 'diverged' ? chalk.magenta(`[Diverged ${currentBranch.track}]`) :
               chalk.gray('[Untracked]'))
            : (head.isDetached ? chalk.red(`[Detached at ${head.commit}]`) : chalk.gray('[Unknown]'));

        const upstreamInfo = currentBranch && currentBranch.upstream
            ? chalk.gray(`(tracks ${currentBranch.upstream})`)
            : chalk.gray('(local only)');

        console.log(`  ◈ Active Branch:   ${chalk.bold.green(branchName)} ${badge} ${upstreamInfo}`);
        console.log(`  ◈ Default Branch:  ${chalk.cyan(defaultBranch)}\n`);

        const otherBranches = branches.filter(b => !b.isCurrent);
        const mergeableBranches = branches.filter(b => b.name !== defaultBranch);

        const choices = [];
        let optNum = 1;

        if (branches.length > 1) {
            choices.push({ name: `${optNum++}. List & View all branches (${branches.length})`, value: 'list' });
        }

        if (otherBranches.length > 0) {
            choices.push({ name: `${optNum++}. Switch active branch`, value: 'switch' });
        }

        choices.push({ name: `${optNum++}. Create new branch`, value: 'create' });

        if (mergeableBranches.length > 0) {
            choices.push({ name: `${optNum++}. Merge a branch into default (${defaultBranch})`, value: 'merge' });
        }

        if (otherBranches.length > 0) {
            choices.push({ name: `${optNum++}. Delete a branch (local / remote)`, value: 'delete' });
        }

        choices.push({ name: `${optNum++}. Return to commit & sync`, value: 'done' });

        const { branchChoice } = await inquirer.prompt([{
            type: 'list',
            name: 'branchChoice',
            message: 'Branch Action:',
            choices
        }]);

        if (branchChoice === 'done') {
            break;
        }

        if (branchChoice === 'list') {
            console.log();
            writeSectionHeader('Local Branches', 'cyan');
            branches.forEach((b) => {
                const prefix = b.isCurrent ? chalk.bold.green('  * ') : '    ';
                const nameStr = b.isCurrent ? chalk.bold.white(b.name) : chalk.cyan(b.name);
                const statusBadge = b.status === 'synced' ? chalk.green('[Synced]') :
                                    b.status === 'ahead' ? chalk.cyan(`[Ahead ${b.track}]`) :
                                    b.status === 'behind' ? chalk.yellow(`[Behind ${b.track}]`) :
                                    b.status === 'diverged' ? chalk.magenta(`[Diverged ${b.track}]`) :
                                    chalk.gray('[Untracked]');
                const upstreamStr = b.upstream ? chalk.gray(`-> ${b.upstream}`) : chalk.gray('(local only)');
                console.log(`${prefix}${nameStr.padEnd(26)} ${statusBadge.padEnd(20)} ${upstreamStr}`);
            });
            console.log();
            await waitForKeypress('Press Enter to return...');
            continue;
        }

        if (branchChoice === 'create') {
            const { newName } = await inquirer.prompt([{
                type: 'input',
                name: 'newName',
                message: 'Enter new branch name (e.g. feature/my-feature):',
                validate: v => {
                    if (!v || !v.trim()) return 'Branch name cannot be empty';
                    if (/\s/.test(v)) return 'Branch name cannot contain spaces';
                    if (branches.some(b => b.name === v.trim())) return `Branch '${v.trim()}' already exists`;
                    return true;
                }
            }]);

            const cleanName = newName.trim();

            const { switchAndReturn } = await inquirer.prompt([{
                type: 'confirm',
                name: 'switchAndReturn',
                message: `Switch to '${cleanName}' and return to commit & sync screen?`,
                default: true
            }]);

            if (switchAndReturn) {
                try {
                    runGit(['checkout', '-b', cleanName], { cwd: localPath });
                    return;
                } catch (err) {
                    feedback = { type: 'error', msg: `Failed to create and switch branch: ${err.message}` };
                }
            } else {
                try {
                    runGit(['branch', cleanName], { cwd: localPath });
                    feedback = { type: 'success', msg: `Created branch '${cleanName}' (active branch remains '${branchName}').` };
                } catch (err) {
                    feedback = { type: 'error', msg: `Failed to create branch: ${err.message}` };
                }
            }
        }

        if (branchChoice === 'switch') {
            const currentOtherBranches = branches.filter(b => !b.isCurrent);
            if (currentOtherBranches.length === 0) {
                feedback = { type: 'warn', msg: 'No other local branches exist to switch to.' };
                continue;
            }

            const { targetBranch } = await inquirer.prompt([{
                type: 'list',
                name: 'targetBranch',
                message: 'Select branch to checkout:',
                choices: currentOtherBranches.map(b => ({
                    name: `${b.name} ${b.upstream ? `(${b.upstream})` : '(untracked)'}`,
                    value: b.name
                }))
            }]);

            const dirty = isDirty(localPath);
            let stashed = false;

            if (dirty) {
                const { stashAction } = await inquirer.prompt([{
                    type: 'list',
                    name: 'stashAction',
                    message: 'Working tree has uncommitted changes. How would you like to proceed?',
                    choices: [
                        { name: '1. Auto-stash changes, switch branch, and restore (pop) stash', value: 'stash_pop' },
                        { name: '2. Switch branch directly (keep uncommitted changes)', value: 'direct' },
                        { name: '3. Cancel branch switch', value: 'cancel' }
                    ]
                }]);

                if (stashAction === 'cancel') continue;

                if (stashAction === 'stash_pop') {
                    stashed = stashPush(localPath, `git-mgr: auto-stash before switching to ${targetBranch}`);
                }
            }

            try {
                runGit(['checkout', targetBranch], { cwd: localPath });
                let msg = `Switched to branch: ${targetBranch}`;

                if (stashed) {
                    try {
                        stashPop(localPath);
                        msg += ' (restored uncommitted changes)';
                    } catch (e) {
                        feedback = { type: 'warn', msg: `Switched to ${targetBranch}, but stash pop had conflicts: ${e.message}` };
                        continue;
                    }
                }
                feedback = { type: 'success', msg };
            } catch (err) {
                if (stashed) {
                    try { stashPop(localPath); } catch {}
                }
                feedback = { type: 'error', msg: `Could not checkout ${targetBranch}: ${err.message}` };
            }
        }

        if (branchChoice === 'merge') {
            const candidateBranches = branches.filter(b => b.name !== defaultBranch);
            if (candidateBranches.length === 0) {
                feedback = { type: 'warn', msg: `No feature branches available to merge into '${defaultBranch}'.` };
                continue;
            }

            const { featureBranch } = await inquirer.prompt([{
                type: 'list',
                name: 'featureBranch',
                message: `Select branch to merge into '${defaultBranch}':`,
                choices: candidateBranches.map(b => ({
                    name: `${b.name} [commit: ${b.commit || 'HEAD'}]`,
                    value: b.name
                }))
            }]);

            const { confirmMerge } = await inquirer.prompt([{
                type: 'confirm',
                name: 'confirmMerge',
                message: `Merge '${featureBranch}' into '${defaultBranch}' now?`,
                default: true
            }]);

            if (!confirmMerge) continue;

            const mergeRes = mergeBranch(defaultBranch, featureBranch, localPath, { autoStash: true });

            if (!mergeRes.success) {
                if (mergeRes.conflict) {
                    feedback = { type: 'error', msg: `Merge conflict in progress: ${mergeRes.reason}` };
                } else {
                    feedback = { type: 'error', msg: `Merge failed: ${mergeRes.reason}` };
                }
                continue;
            }

            console.log();
            writeStatusOK(`Merged '${featureBranch}' into '${defaultBranch}' successfully.`);

            const { pushNow } = await inquirer.prompt([{
                type: 'confirm',
                name: 'pushNow',
                message: `Push updated '${defaultBranch}' to GitHub (remote origin) now?`,
                default: true
            }]);

            if (pushNow) {
                const { pushEnv } = resolvePushEnv(localPath);
                try {
                    runGit(['push', '-u', 'origin', defaultBranch], { cwd: localPath, stdio: 'inherit', env: pushEnv });
                    feedback = { type: 'success', msg: `Merged '${featureBranch}' into '${defaultBranch}' and pushed to remote!` };
                } catch (pushErr) {
                    feedback = { type: 'warn', msg: `Merged '${featureBranch}' into '${defaultBranch}', but push failed: ${pushErr.message}` };
                }
            } else {
                feedback = { type: 'success', msg: `Merged '${featureBranch}' into '${defaultBranch}' locally.` };
            }
        }

        if (branchChoice === 'delete') {
            const deleteCandidates = branches.filter(b => !b.isCurrent);
            if (deleteCandidates.length === 0) {
                feedback = { type: 'warn', msg: 'Cannot delete the only branch. Switch to another branch first.' };
                continue;
            }

            const { branchToDelete } = await inquirer.prompt([{
                type: 'list',
                name: 'branchToDelete',
                message: 'Select branch to delete:',
                choices: deleteCandidates.map(b => ({
                    name: `${b.name} ${b.upstream ? `(remote: ${b.upstream})` : '(local only)'}`,
                    value: b.name
                }))
            }]);

            const targetInfo = deleteCandidates.find(b => b.name === branchToDelete);

            const { confirmDel } = await inquirer.prompt([{
                type: 'confirm',
                name: 'confirmDel',
                message: `Are you sure you want to delete branch '${branchToDelete}'?`,
                default: false
            }]);

            if (!confirmDel) continue;

            let alsoRemote = false;
            if (targetInfo && targetInfo.upstream) {
                const { deleteRemote } = await inquirer.prompt([{
                    type: 'confirm',
                    name: 'deleteRemote',
                    message: `Also delete '${branchToDelete}' on remote origin (GitHub)?`,
                    default: false
                }]);
                alsoRemote = Boolean(deleteRemote);
            }

            const { pushEnv } = resolvePushEnv(localPath);

            try {
                deleteBranch(branchToDelete, { force: false, remote: alsoRemote, env: pushEnv }, localPath);
                feedback = {
                    type: 'success',
                    msg: `Deleted branch '${branchToDelete}'${alsoRemote ? ' (locally and on remote origin)' : ''}.`
                };
            } catch (err) {
                if (err.notFullyMerged) {
                    const { forceDel } = await inquirer.prompt([{
                        type: 'confirm',
                        name: 'forceDel',
                        message: `Branch '${branchToDelete}' has unmerged commits. Force delete (-D)?`,
                        default: false
                    }]);

                    if (forceDel) {
                        try {
                            deleteBranch(branchToDelete, { force: true, remote: alsoRemote, env: pushEnv }, localPath);
                            feedback = {
                                type: 'success',
                                msg: `Force deleted branch '${branchToDelete}'${alsoRemote ? ' (locally and on remote origin)' : ''}.`
                            };
                        } catch (e2) {
                            feedback = { type: 'error', msg: `Failed to force delete branch: ${e2.message}` };
                        }
                    }
                } else {
                    feedback = { type: 'error', msg: `Failed to delete branch: ${err.message}` };
                }
            }
        }
    }
}

module.exports = { handleBranchOperations };
