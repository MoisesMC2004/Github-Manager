const chalk = require('chalk');
const inquirer = require('inquirer');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');

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
const { selectProfile, getToken } = require('../profiles');
const { fetchUserRepositories, deleteRemoteRepo } = require('../api');
const { removeTrackedProjectByRepo } = require('../projects');

function findLocalCandidateRepos(repoName, owner = '') {
    const cleanRepo = repoName.toLowerCase();
    const cleanOwner = (owner || '').toLowerCase();
    const candidates = new Set();

    const searchDirs = [
        process.cwd(),
        path.join(path.dirname(process.cwd()), repoName),
        path.join(os.homedir(), 'Projects', repoName),
        path.join(os.homedir(), repoName)
    ];

    for (const dir of searchDirs) {
        try {
            const resolved = path.resolve(dir);
            if (!fs.existsSync(resolved)) continue;
            const gitDir = path.join(resolved, '.git');
            if (!fs.existsSync(gitDir)) continue;

            const baseMatch = path.basename(resolved).toLowerCase() === cleanRepo;
            let configMatch = false;
            const gitConfigFile = path.join(gitDir, 'config');
            if (fs.existsSync(gitConfigFile)) {
                const configText = fs.readFileSync(gitConfigFile, 'utf8').toLowerCase();
                const hasRepoInUrl = configText.includes(`/${cleanRepo}.git`) ||
                                     configText.includes(`/${cleanRepo}`) ||
                                     configText.includes(`:${cleanRepo}.git`);
                const hasOwnerInUrl = cleanOwner ? configText.includes(cleanOwner) : true;
                configMatch = hasRepoInUrl && hasOwnerInUrl;
            }

            if (baseMatch || configMatch) {
                candidates.add(resolved);
            }
        } catch {}
    }

    return Array.from(candidates);
}

async function deleteProject() {
    clearHost();
    writeBanner('Delete GitHub Repository', 'red');

    const profile = await selectProfile();
    if (!profile) return;

    const token = await getToken(profile);
    if (!token) {
        writeStatusWarn('A GitHub Personal Access Token is required to list and delete repositories via API.');
        await waitForKeypress();
        return;
    }

    writeStatusInfo('Fetching repositories list from GitHub...');
    const repos = await fetchUserRepositories(profile, token);
    if (!repos) {
        writeStatusError('Could not fetch repositories list from GitHub.');
        await waitForKeypress();
        return;
    }

    if (repos.length === 0) {
        writeStatusWarn(`No repositories found under account '${profile.github_user}'.`);
        await waitForKeypress();
        return;
    }

    console.log();
    const choices = repos.map(r => ({
        name: `${chalk.bold.white(r.name)} ${r.private ? chalk.yellow('[Private]') : chalk.gray('[Public]')}${r.description ? chalk.gray(' - ' + r.description) : ''}`,
        value: r
    }));

    choices.push(new inquirer.Separator());
    choices.push({ name: chalk.gray('◈ Cancel and return'), value: null });

    const { selectedRepo } = await inquirer.prompt([{
        type: 'list',
        name: 'selectedRepo',
        message: `Select repository to delete (${profile.github_user}):`,
        choices,
        pageSize: 15
    }]);

    if (!selectedRepo) {
        writeStatusWarn('Deletion cancelled.');
        await waitForKeypress();
        return;
    }

    const repoName = selectedRepo.name;
    const owner = selectedRepo.owner || profile.github_user;

    console.log();
    writeSectionHeader(`WARNING: Deleting ${owner}/${repoName}`, 'red');
    console.log(chalk.red(`\n  ⚠ WARNING: This action CANNOT be undone.`));
    console.log(chalk.red(`  This will permanently delete '${owner}/${repoName}' and its entire Git history on GitHub.\n`));

    const { confirm1 } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm1',
        message: `Are you sure you want to delete '${repoName}'?`,
        default: false
    }]);

    if (!confirm1) {
        writeStatusWarn('Operation cancelled.');
        await waitForKeypress();
        return;
    }

    const { confirmName } = await inquirer.prompt([{
        type: 'input',
        name: 'confirmName',
        message: `To confirm, please type the repository name '${repoName}':`,
        validate: v => v.trim() ? true : 'Please enter repository name to confirm'
    }]);

    if (confirmName.trim() !== repoName) {
        writeStatusError('Entered name did not match repository name. Deletion aborted.');
        await waitForKeypress();
        return;
    }

    console.log(chalk.gray(`\n  ◈ Deleting '${owner}/${repoName}' on GitHub...`));
    try {
        const res = await deleteRemoteRepo(token, owner, repoName);

        if (res.status === 204) {
            console.log();
            writeStatusOK(`Repository '${owner}/${repoName}' was permanently deleted from GitHub!`);

            const matchedProjects = removeTrackedProjectByRepo(repoName, owner);

            if (matchedProjects.length > 0) {
                console.log(chalk.gray(`  Removed '${repoName}' from local tracked projects list.`));

                for (const p of matchedProjects) {
                    if (p.path && fs.existsSync(p.path)) {
                        const localGit = path.join(p.path, '.git');
                        if (fs.existsSync(localGit)) {
                            console.log();
                            const { removeLocalGit } = await inquirer.prompt([{
                                type: 'confirm',
                                name: 'removeLocalGit',
                                message: `Found local folder at '${p.path}'. Also delete its .git folder (unlink from Git)?`,
                                default: false
                            }]);

                            if (removeLocalGit) {
                                try {
                                    fs.removeSync(localGit);
                                    writeStatusOK(`Removed local .git folder from: ${p.path}`);
                                } catch (err) {
                                    writeStatusError(`Could not remove .git folder: ${err.message}`);
                                }
                            } else {
                                writeStatusInfo(`Preserved local files and .git folder in: ${p.path}`);
                            }
                        }
                    }
                }
            } else {
                // Fallback detection for untracked local repository
                const candidates = findLocalCandidateRepos(repoName, owner);

                if (candidates.length > 0) {
                    for (const candidate of candidates) {
                        const localGit = path.join(candidate, '.git');
                        console.log();
                        writeStatusInfo(`Detected untracked local repository matching '${repoName}':`);
                        console.log(chalk.gray(`  ${candidate}`));

                        const { removeCandidateGit } = await inquirer.prompt([{
                            type: 'confirm',
                            name: 'removeCandidateGit',
                            message: 'Delete its .git folder (unlink from Git)?',
                            default: false
                        }]);

                        if (removeCandidateGit) {
                            try {
                                fs.removeSync(localGit);
                                writeStatusOK(`Removed local .git folder from: ${candidate}`);
                            } catch (err) {
                                writeStatusError(`Could not remove .git folder: ${err.message}`);
                            }
                        } else {
                            writeStatusInfo(`Preserved local files and .git folder in: ${candidate}`);
                        }
                    }
                } else {
                    console.log();
                    const { unlinkManual } = await inquirer.prompt([{
                        type: 'confirm',
                        name: 'unlinkManual',
                        message: `No tracked local folder found for '${repoName}'. Unlink a local folder manually?`,
                        default: false
                    }]);

                    if (unlinkManual) {
                        const { manualPath } = await inquirer.prompt([{
                            type: 'input',
                            name: 'manualPath',
                            message: 'Enter local folder path to unlink:',
                            default: process.cwd(),
                            validate: p => {
                                const resolved = path.resolve(p.trim());
                                if (!fs.existsSync(resolved)) return 'Folder does not exist on disk';
                                if (!fs.existsSync(path.join(resolved, '.git'))) return 'Folder does not contain a .git directory';
                                return true;
                            }
                        }]);

                        const resolvedManual = path.resolve(manualPath.trim());
                        const manualGit = path.join(resolvedManual, '.git');

                        const { confirmManualRemove } = await inquirer.prompt([{
                            type: 'confirm',
                            name: 'confirmManualRemove',
                            message: `Are you sure you want to delete .git folder from '${resolvedManual}'?`,
                            default: false
                        }]);

                        if (confirmManualRemove) {
                            try {
                                fs.removeSync(manualGit);
                                writeStatusOK(`Removed local .git folder from: ${resolvedManual}`);
                            } catch (err) {
                                writeStatusError(`Could not remove .git folder: ${err.message}`);
                            }
                        } else {
                            writeStatusInfo(`Preserved local files and .git folder in: ${resolvedManual}`);
                        }
                    }
                }
            }
        } else {
            console.log();
            writeStatusError(`Failed to delete repository (HTTP ${res.status}).`);
            if (res.data?.message) {
                console.log(chalk.yellow(`  GitHub message: ${res.data.message}`));
            }
            if (res.status === 403 || res.status === 404) {
                console.log(chalk.gray('  Ensure your token has the "delete_repo" scope at https://github.com/settings/tokens'));
            }
        }
    } catch (e) {
        console.log();
        writeStatusError(`API connection error: ${e.message}`);
    }

    await waitForKeypress();
}

module.exports = { deleteProject };
