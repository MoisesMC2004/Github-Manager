const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const inquirer = require('inquirer');
const { PROJECTS_PATH } = require('./config');

function getTrackedProjects() {
    try {
        if (!fs.existsSync(PROJECTS_PATH)) return [];
        const data = fs.readJsonSync(PROJECTS_PATH);
        return Array.isArray(data.projects) ? data.projects : [];
    } catch {
        return [];
    }
}

function saveTrackedProjects(projects) {
    try {
        if (!projects || projects.length === 0) {
            if (fs.existsSync(PROJECTS_PATH)) {
                try { fs.removeSync(PROJECTS_PATH); } catch {}
            }
            return;
        }
        fs.writeJsonSync(PROJECTS_PATH, { projects }, { spaces: 4, mode: 0o600 });
        try { fs.chmodSync(PROJECTS_PATH, 0o600); } catch {}
    } catch {}
}

function addTrackedProject(folderPath, repoName = '', githubUser = '') {
    if (!folderPath) return;
    const normalized = path.resolve(folderPath);
    if (!fs.existsSync(normalized) || !fs.existsSync(path.join(normalized, '.git'))) return;

    const projects = getTrackedProjects();
    const existingIndex = projects.findIndex(p => path.resolve(p.path).toLowerCase() === normalized.toLowerCase());

    const name = repoName || path.basename(normalized);
    const entry = {
        name,
        path: normalized,
        repo: repoName || (existingIndex >= 0 ? projects[existingIndex].repo : name),
        github_user: githubUser || (existingIndex >= 0 ? projects[existingIndex].github_user : ''),
        last_sync: new Date().toISOString()
    };

    if (existingIndex >= 0) {
        projects[existingIndex] = { ...projects[existingIndex], ...entry };
    } else {
        projects.unshift(entry);
    }

    saveTrackedProjects(projects);
}

function removeTrackedProjectByRepo(repoName, owner = '') {
    if (!repoName) return [];
    const cleanRepo = repoName.toLowerCase();
    const cleanOwner = (owner || '').toLowerCase();
    const all = getTrackedProjects();
    const remaining = [];
    const removed = [];

    for (const p of all) {
        const matchesRepo = (p.repo && p.repo.toLowerCase() === cleanRepo) || (p.name && p.name.toLowerCase() === cleanRepo);
        const matchesOwner = cleanOwner ? (!p.github_user || p.github_user.toLowerCase() === cleanOwner) : true;
        if (matchesRepo && matchesOwner) {
            removed.push(p);
        } else {
            remaining.push(p);
        }
    }

    saveTrackedProjects(remaining);
    return removed;
}

function getValidTrackedProjects() {
    const all = getTrackedProjects();
    return all.filter(p => {
        try {
            return fs.existsSync(p.path) && fs.existsSync(path.join(p.path, '.git'));
        } catch {
            return false;
        }
    });
}

async function selectProjectForSync() {
    const validProjects = getValidTrackedProjects();

    if (validProjects.length > 0) {
        console.log(chalk.gray(`  Found ${chalk.yellow(validProjects.length)} previously tracked Git project(s).\n`));

        const choices = validProjects.map(p => {
            const userTag = p.github_user ? chalk.cyan(`[${p.github_user}] `) : '';
            return {
                name: `${userTag}${chalk.bold.white(p.name || path.basename(p.path))}  ${chalk.gray(p.path)}`,
                value: p.path
            };
        });

        choices.push(new inquirer.Separator());
        choices.push({
            name: chalk.yellow('◈ Enter custom folder path...'),
            value: '_CUSTOM_'
        });

        const { chosen } = await inquirer.prompt([{
            type: 'list',
            name: 'chosen',
            message: 'Select repository to commit & push:',
            choices,
            pageSize: 15
        }]);

        if (chosen !== '_CUSTOM_') {
            return chosen;
        }
    } else {
        console.log(chalk.gray('  No previously published projects found in registry.\n'));
    }

    console.log();
    const { customPath } = await inquirer.prompt([{
        type: 'input',
        name: 'customPath',
        message: 'Enter local Git repository path:',
        default: process.cwd(),
        validate: p => {
            const resolved = path.resolve(p.trim());
            if (!fs.existsSync(resolved)) return 'Path does not exist on disk';
            if (!fs.existsSync(path.join(resolved, '.git'))) return 'Specified folder is not a Git repository (missing .git)';
            return true;
        }
    }]);

    const resolvedCustom = path.resolve(customPath.trim());
    addTrackedProject(resolvedCustom);
    return resolvedCustom;
}

module.exports = {
    getTrackedProjects,
    saveTrackedProjects,
    addTrackedProject,
    removeTrackedProjectByRepo,
    getValidTrackedProjects,
    selectProjectForSync
};
