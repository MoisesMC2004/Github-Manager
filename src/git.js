const { spawnSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const { getProfiles } = require('./profiles');
const { getProfileSSHCommand } = require('./ssh');

/**
 * Executes a Git command safely using argument arrays to prevent shell injection.
 * @param {string[]} args - Argument list passed directly to the git executable.
 * @param {object} options - Options containing cwd, env, stdio.
 * @returns {string} - Trimmed stdout if captured.
 */
function runGit(args, options = {}) {
    const cwd = options.cwd || process.cwd();
    const env = options.env || process.env;
    const stdio = options.stdio || ['pipe', 'pipe', 'pipe'];

    const res = spawnSync('git', args, {
        cwd,
        env,
        stdio,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
    });

    if (res.error) {
        throw res.error;
    }

    if (res.status !== 0) {
        const stderr = res.stderr ? res.stderr.trim() : '';
        const stdout = res.stdout ? res.stdout.trim() : '';
        const errMessage = stderr || stdout || `Git command failed with code ${res.status}: git ${args.join(' ')}`;
        const err = new Error(errMessage);
        err.status = res.status;
        err.stdout = stdout;
        err.stderr = stderr;
        throw err;
    }

    return res.stdout ? res.stdout.trim() : '';
}

/**
 * Checks whether git binary is installed and executable.
 * @returns {boolean}
 */
function testGit() {
    try {
        const res = spawnSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
        return res.status === 0;
    } catch {
        return false;
    }
}

/**
 * Returns string description of active merge/rebase/cherry-pick conflict, or null if clean.
 * @param {string} cwd
 * @returns {string|null}
 */
function getMergeConflictReason(cwd) {
    let gitDir = '';
    try {
        gitDir = runGit(['rev-parse', '--git-dir'], { cwd }).trim();
        if (!path.isAbsolute(gitDir)) {
            gitDir = path.resolve(cwd, gitDir);
        }
    } catch {
        return null;
    }

    if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
        return 'Merge conflict in progress (.git/MERGE_HEAD present)';
    }
    if (fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))) {
        return 'Rebase in progress (.git/rebase-* present)';
    }
    if (fs.existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) {
        return 'Cherry-pick conflict in progress (.git/CHERRY_PICK_HEAD present)';
    }
    if (fs.existsSync(path.join(gitDir, 'REVERT_HEAD'))) {
        return 'Revert in progress (.git/REVERT_HEAD present)';
    }

    // Check porcelain status for unmerged codes (UU, AA, DD, etc.)
    try {
        const status = runGit(['status', '--porcelain'], { cwd });
        const unmergedLines = status.split(/\r?\n/).filter(line => /^(UU|AA|DD|UD|DU|AU|UA)\s/.test(line));
        if (unmergedLines.length > 0) {
            return `Unmerged conflict markers found in working tree (${unmergedLines.length} file(s))`;
        }
    } catch {}

    return null;
}

/**
 * Checks whether the repository has an active merge, rebase, or unresolved conflict.
 * @param {string} cwd
 * @returns {boolean}
 */
function hasMergeConflicts(cwd) {
    return Boolean(getMergeConflictReason(cwd));
}

/**
 * Accurately gets current branch name or detects detached HEAD state.
 * @param {string} cwd
 * @returns {{ branch: string|null, isDetached: boolean, commit: string }}
 */
function getCurrentBranch(cwd) {
    let commit = '';
    try {
        commit = runGit(['rev-parse', '--short', 'HEAD'], { cwd }).trim();
    } catch {}

    try {
        const branch = runGit(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd }).trim();
        if (branch) {
            return { branch, isDetached: false, commit };
        }
    } catch {}

    return { branch: null, isDetached: true, commit };
}

/**
 * Checks if the repository working tree has untracked or uncommitted changes.
 * @param {string} cwd
 * @returns {boolean}
 */
function isDirty(cwd) {
    try {
        const status = runGit(['status', '--porcelain'], { cwd }).trim();
        return status.length > 0;
    } catch {
        return false;
    }
}

/**
 * Stashes uncommitted changes safely.
 * @param {string} cwd
 * @param {string} message
 * @returns {boolean} true if changes were stashed, false if clean
 */
function stashPush(cwd, message = 'git-mgr: auto-stash') {
    try {
        const out = runGit(['stash', 'push', '-u', '-m', message], { cwd });
        return !out.includes('No local changes to save');
    } catch {
        return false;
    }
}

/**
 * Restores the most recently stashed changes.
 * @param {string} cwd
 * @returns {boolean}
 */
function stashPop(cwd) {
    try {
        runGit(['stash', 'pop'], { cwd });
        return true;
    } catch (e) {
        throw new Error(`Failed to restore stash: ${e.message}`);
    }
}

/**
 * Parses and returns list of local branches with tracking state.
 * @param {string} cwd
 * @returns {Array<{ name: string, isCurrent: boolean, upstream: string|null, status: string, track: string, commit: string, subject: string }>}
 */
function getBranches(cwd) {
    try {
        const format = '%(HEAD)|%(refname:short)|%(upstream:short)|%(upstream:track)|%(objectname:short)|%(contents:subject)';
        const out = runGit(['for-each-ref', `--format=${format}`, 'refs/heads'], { cwd });
        if (!out) return [];

        return out.split(/\r?\n/).filter(Boolean).map(line => {
            const parts = line.split('|');
            const isCurrent = parts[0].trim() === '*';
            const name = parts[1] || '';
            const upstream = parts[2] ? parts[2].trim() : null;
            const track = parts[3] ? parts[3].trim() : '';
            const commit = parts[4] ? parts[4].trim() : '';
            const subject = parts.slice(5).join('|').trim();

            let status = 'untracked';
            if (upstream) {
                if (track.includes('gone')) {
                    status = 'gone';
                } else if (track.includes('ahead') && track.includes('behind')) {
                    status = 'diverged';
                } else if (track.includes('ahead')) {
                    status = 'ahead';
                } else if (track.includes('behind')) {
                    status = 'behind';
                } else {
                    status = 'synced';
                }
            }

            return {
                name,
                isCurrent,
                upstream,
                status,
                track,
                commit,
                subject
            };
        });
    } catch {
        return [];
    }
}

/**
 * Detects the default primary branch (e.g. main or master).
 * @param {string} cwd
 * @returns {string}
 */
function getDefaultBranch(cwd) {
    try {
        const remoteHead = runGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd }).trim();
        if (remoteHead) {
            return remoteHead.replace(/^origin\//, '');
        }
    } catch {}

    try {
        const branches = runGit(['branch', '--format=%(refname:short)'], { cwd })
            .split(/\r?\n/)
            .map(s => s.trim())
            .filter(Boolean);

        if (branches.includes('main')) return 'main';
        if (branches.includes('master')) return 'master';
        if (branches.includes('trunk')) return 'trunk';
        if (branches.length > 0) return branches[0];
    } catch {}

    return 'main';
}

/**
 * Safely merges sourceBranch into targetBranch.
 * @param {string} targetBranch - Destination branch (e.g. main).
 * @param {string} sourceBranch - Feature branch to merge.
 * @param {string} cwd
 * @param {object} options - Options: noFf (boolean), message (string), autoStash (boolean).
 * @returns {{ success: boolean, conflict?: boolean, reason?: string, targetBranch?: string, sourceBranch?: string }}
 */
function mergeBranch(targetBranch, sourceBranch, cwd, options = {}) {
    if (hasMergeConflicts(cwd)) {
        return {
            success: false,
            conflict: true,
            reason: getMergeConflictReason(cwd) || 'Repository already has active merge/rebase conflicts'
        };
    }

    if (isDirty(cwd)) {
        if (!options.autoStash) {
            return {
                success: false,
                conflict: false,
                reason: 'Working tree has uncommitted changes'
            };
        }
        stashPush(cwd, `git-mgr: auto-stash before merging ${sourceBranch} into ${targetBranch}`);
    }

    const current = getCurrentBranch(cwd);
    if (current.branch !== targetBranch) {
        try {
            runGit(['checkout', targetBranch], { cwd });
        } catch (e) {
            return {
                success: false,
                conflict: false,
                reason: `Failed to checkout target branch '${targetBranch}': ${e.message}`
            };
        }
    }

    const mergeArgs = ['merge'];
    if (options.noFf !== false) {
        mergeArgs.push('--no-ff');
    }
    mergeArgs.push(sourceBranch);

    if (options.message) {
        mergeArgs.push('-m', options.message);
    } else {
        mergeArgs.push('-m', `Merge branch '${sourceBranch}' into ${targetBranch}`);
    }

    try {
        runGit(mergeArgs, { cwd });
        return {
            success: true,
            targetBranch,
            sourceBranch
        };
    } catch (err) {
        if (hasMergeConflicts(cwd)) {
            return {
                success: false,
                conflict: true,
                reason: getMergeConflictReason(cwd) || 'Merge conflict detected'
            };
        }
        return {
            success: false,
            conflict: false,
            reason: err.message
        };
    }
}

/**
 * Deletes a branch locally and optionally on the remote.
 * @param {string} branchName
 * @param {object} options - Options: force (boolean), remote (boolean), env (object).
 * @param {string} cwd
 * @returns {{ success: boolean, localDeleted: boolean, remoteDeleted: boolean }}
 */
function deleteBranch(branchName, options = {}, cwd = process.cwd()) {
    const head = getCurrentBranch(cwd);
    if (head.branch === branchName) {
        throw new Error(`Cannot delete active branch '${branchName}'. Checkout another branch first.`);
    }

    const force = Boolean(options.force);
    const deleteFlag = force ? '-D' : '-d';

    try {
        runGit(['branch', deleteFlag, branchName], { cwd });
    } catch (err) {
        const msg = (err.stderr || err.message || '').toString();
        if (msg.includes('not fully merged')) {
            const error = new Error(`Branch '${branchName}' is not fully merged.`);
            error.notFullyMerged = true;
            throw error;
        }
        throw err;
    }

    let remoteDeleted = false;
    if (options.remote) {
        const env = options.env || process.env;
        runGit(['push', 'origin', '--delete', branchName], { cwd, env });
        remoteDeleted = true;
    }

    return {
        success: true,
        localDeleted: true,
        remoteDeleted
    };
}

/**
 * Stages all changes and creates a commit safely.
 * @param {string} localPath
 * @param {string} message
 */
function stageAndCommit(localPath, message = 'Update') {
    runGit(['add', '-A'], { cwd: localPath, stdio: 'ignore' });
    return runGit(['commit', '-m', message], { cwd: localPath, stdio: 'ignore' });
}

/**
 * Resolves repository push context and dedicated SSH command.
 * @param {string} localPath
 * @returns {{ pushEnv: object, matchedUser: string, repoName: string }}
 */
function resolvePushEnv(localPath) {
    const pushEnv = { ...process.env };
    let matchedUser = '';
    let repoName = path.basename(localPath);

    try {
        const originUrl = runGit(['remote', 'get-url', 'origin'], { cwd: localPath });
        const match = originUrl.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
        if (match) {
            matchedUser = match[1];
            repoName = match[2];
            const profiles = getProfiles();
            const found = profiles.find(p => p.github_user.toLowerCase() === matchedUser.toLowerCase());
            if (found) {
                const sshCmd = getProfileSSHCommand(found);
                pushEnv.GIT_SSH_COMMAND = sshCmd;
                try {
                    runGit(['config', '--local', 'core.sshCommand', sshCmd], { cwd: localPath });
                } catch {}
            }
        }
    } catch {}

    return { pushEnv, matchedUser, repoName };
}

module.exports = {
    runGit,
    testGit,
    getMergeConflictReason,
    hasMergeConflicts,
    getCurrentBranch,
    isDirty,
    stashPush,
    stashPop,
    getBranches,
    getDefaultBranch,
    mergeBranch,
    deleteBranch,
    stageAndCommit,
    resolvePushEnv
};
