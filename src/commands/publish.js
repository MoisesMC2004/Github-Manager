const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const inquirer = require('inquirer');

const {
    clearHost,
    writeBanner,
    writeStatusOK,
    writeStatusError,
    writeStatusWarn,
    writeStatusInfo,
    getSafeRepoName,
    waitForKeypress
} = require('../ui');
const { runGit, hasMergeConflicts, getMergeConflictReason, getCurrentBranch, getDefaultBranch, stageAndCommit } = require('../git');
const { getProfileSSHCommand } = require('../ssh');
const { selectProfile, getToken } = require('../profiles');
const { createRemoteRepo } = require('../api');
const { addTrackedProject } = require('../projects');

async function publishProject(inputPath, inputRepoName, inputProfile) {
    let localPath = inputPath;
    let repoName = inputRepoName;
    let profile = inputProfile;

    if (!localPath || !repoName || !profile) {
        clearHost();
        writeBanner('Publish New Project to GitHub', 'cyan');

        const { enteredPath } = await inquirer.prompt([{
            type: 'input',
            name: 'enteredPath',
            message: 'Enter local folder path to publish:',
            default: process.cwd(),
            validate: p => fs.existsSync(p.trim()) ? true : 'Folder does not exist on disk'
        }]);

        const resolved = path.resolve(enteredPath.trim());
        const defaultName = getSafeRepoName(path.basename(resolved));

        console.log();
        const { rawRepoName } = await inquirer.prompt([{
            type: 'input',
            name: 'rawRepoName',
            message: 'Repository name on GitHub:',
            default: defaultName
        }]);

        localPath = resolved;
        repoName = getSafeRepoName(rawRepoName);

        profile = await selectProfile();
        if (!profile) return;
    }

    clearHost();
    writeBanner(`Publish: ${repoName}`, 'cyan');
    console.log(chalk.gray(`  Local path:  ${localPath}`));
    console.log(chalk.gray(`  GitHub repo: ${profile.github_user}/${repoName}\n`));

    const sshCmd = getProfileSSHCommand(profile);

    // Ensure repo is initialized
    if (!fs.existsSync(path.join(localPath, '.git'))) {
        console.log(chalk.yellow('  ◈ Local folder is not a Git repository.'));
        const { init } = await inquirer.prompt([{
            type: 'confirm',
            name: 'init',
            message: 'Initialize Git repository now?',
            default: true
        }]);
        if (!init) {
            await waitForKeypress();
            return;
        }

        runGit(['init'], { cwd: localPath, stdio: 'ignore' });
        writeStatusOK('Git repository initialized.');
    }

    // Check for active merge/rebase conflicts
    if (hasMergeConflicts(localPath)) {
        const reason = getMergeConflictReason(localPath);
        writeStatusError(`Cannot publish repository: ${reason}`);
        console.log(chalk.yellow('  Please resolve conflicts before publishing.\n'));
        await waitForKeypress();
        return;
    }

    // Configure user identity and dedicated SSH command for this repository
    try {
        runGit(['config', '--local', 'user.name', profile.name], { cwd: localPath });
        if (profile.email) {
            runGit(['config', '--local', 'user.email', profile.email], { cwd: localPath });
        }
        runGit(['config', '--local', 'core.sshCommand', sshCmd], { cwd: localPath });
    } catch (e) {
        writeStatusWarn(`Could not apply local git configuration: ${e.message}`);
    }

    // Check changes & commits
    runGit(['add', '-A'], { cwd: localPath, stdio: 'ignore' });
    let hasChanges = false;
    try {
        const status = runGit(['diff', '--cached', '--name-only'], { cwd: localPath });
        hasChanges = status.length > 0;
    } catch {}

    let hasCommits = false;
    try {
        runGit(['rev-parse', 'HEAD'], { cwd: localPath });
        hasCommits = true;
    } catch {}

    if (hasChanges || !hasCommits) {
        console.log();
        const { msg } = await inquirer.prompt([{
            type: 'input',
            name: 'msg',
            message: 'Commit message:',
            default: `Initial commit: ${repoName}`
        }]);

        const commitMessage = (msg && msg.trim()) || `Initial commit: ${repoName}`;
        try {
            stageAndCommit(localPath, commitMessage);
            writeStatusOK('Commit created.');
        } catch {
            if (!hasCommits) {
                runGit(['commit', '--allow-empty', '-m', 'Initial commit'], { cwd: localPath, stdio: 'ignore' });
                writeStatusOK('Initial empty commit created.');
            }
        }
    }

    // Ensure active branch (default to main if not set)
    const head = getCurrentBranch(localPath);
    const publishBranch = head.branch || getDefaultBranch(localPath) || 'main';
    try {
        runGit(['branch', '-M', publishBranch], { cwd: localPath, stdio: 'ignore' });
    } catch {}

    // Check or create remote repo on GitHub
    const token = await getToken(profile);
    if (token) {
        console.log();
        const { isPrivate } = await inquirer.prompt([{
            type: 'confirm',
            name: 'isPrivate',
            message: 'Make this repository PRIVATE on GitHub?',
            default: true
        }]);

        const { desc } = await inquirer.prompt([{
            type: 'input',
            name: 'desc',
            message: 'Repository description (optional):',
            default: ''
        }]);

        try {
            const res = await createRemoteRepo(token, repoName, isPrivate, desc.trim());

            if (res.status === 201) {
                writeStatusOK(`Repository created on GitHub: https://github.com/${profile.github_user}/${repoName}`);
            } else if (res.status === 422) {
                writeStatusInfo(`Repository '${repoName}' already exists on GitHub for ${profile.github_user}. Connecting...`);
            } else {
                writeStatusError(`GitHub API Status ${res.status}: ${res.data?.message || 'Could not verify repo'}`);
            }
        } catch (e) {
            writeStatusWarn(`API request failed: ${e.message}`);
        }
    }

    // Set remote origin
    const remoteUrl = `git@${profile.ssh_host || 'github.com'}:${profile.github_user}/${repoName}.git`;
    try {
        const remotesOutput = runGit(['remote'], { cwd: localPath });
        const remotes = remotesOutput.split(/\s+/);
        if (remotes.includes('origin')) {
            runGit(['remote', 'set-url', 'origin', remoteUrl], { cwd: localPath });
        } else {
            runGit(['remote', 'add', 'origin', remoteUrl], { cwd: localPath });
        }
        writeStatusOK(`Remote origin set to: ${remoteUrl}`);
    } catch (e) {
        writeStatusError(`Failed to set remote: ${e.message}`);
        await waitForKeypress();
        return;
    }

    // Push to GitHub
    console.log(chalk.cyan(`\n  ◈ Pushing branch '${publishBranch}' to GitHub...`));
    try {
        runGit(['push', '-u', 'origin', publishBranch], {
            cwd: localPath,
            stdio: 'inherit',
            env: { ...process.env, GIT_SSH_COMMAND: sshCmd }
        });
        console.log();
        writeStatusOK('Successfully published to GitHub!');
        console.log(chalk.cyan(`  URL: https://github.com/${profile.github_user}/${repoName}`));

        // Register in tracked projects
        addTrackedProject(localPath, repoName, profile.github_user);
        writeStatusOK('Added to tracked projects registry for Quick Commit & Push!');
        console.log();
    } catch (e) {
        console.log();
        writeStatusError(`Git push failed: ${e.message}. Ensure your SSH key is added to GitHub.`);
    }

    await waitForKeypress();
}

module.exports = { publishProject };
