const path = require('path');
const fs = require('fs-extra');
const chalk = require('chalk');
const os = require('os');
const inquirer = require('inquirer');

const { PROFILES_PATH, TOKENS_PATH } = require('./config');
const {
    clearHost,
    writeBanner,
    writeSectionHeader,
    writeStatusOK,
    writeStatusError,
    writeStatusWarn,
    copyToClipboard,
    openUrl,
    waitForKeypress
} = require('./ui');
const {
    getProfileSSHKeyPath,
    testSSHConnection,
    generateDedicatedSSHKey,
    handleSSHKeySetup
} = require('./ssh');

function getProfiles() {
    try {
        if (!fs.existsSync(PROFILES_PATH)) return [];
        const data = fs.readJsonSync(PROFILES_PATH);
        return (data.profiles || []).filter(p => p && p.github_user).map(p => ({
            ...p,
            ssh_host: p.ssh_host || 'github.com'
        }));
    } catch {
        return [];
    }
}

function saveProfiles(profiles) {
    if (!profiles || profiles.length === 0) {
        if (fs.existsSync(PROFILES_PATH)) {
            try { fs.removeSync(PROFILES_PATH); } catch {}
        }
        return;
    }
    fs.writeJsonSync(PROFILES_PATH, { profiles }, { spaces: 4, mode: 0o600 });
    try { fs.chmodSync(PROFILES_PATH, 0o600); } catch {}
}

function getTokens() {
    try {
        if (!fs.existsSync(TOKENS_PATH)) return {};
        return fs.readJsonSync(TOKENS_PATH).tokens || {};
    } catch {
        return {};
    }
}

function saveTokens(tokens) {
    if (!tokens || Object.keys(tokens).length === 0) {
        if (fs.existsSync(TOKENS_PATH)) {
            try { fs.removeSync(TOKENS_PATH); } catch {}
        }
        return;
    }
    fs.writeJsonSync(TOKENS_PATH, { tokens }, { spaces: 4, mode: 0o600 });
    try { fs.chmodSync(TOKENS_PATH, 0o600); } catch {}
}

function getEnvTokenForUser(gitHubUser) {
    const safeUser = (gitHubUser || '').replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
    const specific = process.env[`GITHUB_TOKEN_${safeUser}`];
    if (specific) return specific;
    return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;
}

async function getToken(profile) {
    if (profile.token) return profile.token;

    const tokens = getTokens();
    if (tokens[profile.github_user]) return tokens[profile.github_user];

    const envTok = getEnvTokenForUser(profile.github_user);
    if (envTok) return envTok;

    writeStatusWarn(`No Personal Access Token configured for '${profile.github_user}'.`);
    console.log(chalk.gray('  To perform API operations (such as automatic repository creation or deletion):'));
    console.log(chalk.gray('  1. Generate a classic token at: ') + chalk.cyan('https://github.com/settings/tokens'));
    console.log(chalk.yellow('     Scopes required: ') + chalk.white('repo, delete_repo'));
    console.log();

    const { inputToken } = await inquirer.prompt([{
        type: 'password',
        name: 'inputToken',
        message: `Paste Personal Access Token for ${profile.github_user} (or press Enter to skip):`,
        mask: '•'
    }]);

    if (!inputToken || !inputToken.trim()) return null;

    const cleanToken = inputToken.trim();
    profile.token = cleanToken;
    tokens[profile.github_user] = cleanToken;
    saveTokens(tokens);

    try {
        const profiles = getProfiles();
        const idx = profiles.findIndex(p => p.github_user === profile.github_user);
        if (idx >= 0) {
            profiles[idx].token = cleanToken;
            saveProfiles(profiles);
        }
    } catch {}

    writeStatusOK('Token saved.');
    return cleanToken;
}

async function createProfileInteractive() {
    clearHost();
    writeBanner('Setup GitHub Profile Wizard', 'cyan');
    console.log(chalk.gray('  Follow this guided wizard to link and verify your GitHub account.\n'));

    // Step 1: Account Information
    writeSectionHeader('Step 1 of 4: Account Information', 'cyan');
    const answers = await inquirer.prompt([
        {
            type: 'input',
            name: 'name',
            message: 'Profile label (e.g. Personal, Work, Main):',
            default: 'Main',
            validate: v => v.trim() ? true : 'Profile label is required'
        },
        {
            type: 'input',
            name: 'github_user',
            message: 'GitHub username (e.g. octocat):',
            validate: v => v.trim() ? true : 'GitHub username is required'
        },
        {
            type: 'input',
            name: 'email',
            message: 'GitHub email (for commit author):',
            validate: v => v.trim() ? true : 'GitHub email is required'
        }
    ]);

    const githubUser = answers.github_user.trim();
    const email = answers.email.trim();
    const name = answers.name.trim();
    const sshHost = 'github.com';

    // Step 2: Dedicated SSH Key Generation for this account
    console.log();
    writeSectionHeader(`Step 2 of 4: Dedicated SSH Key for '${githubUser}'`, 'cyan');
    console.log(chalk.gray(`  Generating an isolated, dedicated SSH key for this account...`));

    const keyRes = generateDedicatedSSHKey(githubUser, email);
    if (!keyRes.success) {
        writeStatusError(`Failed to generate SSH key: ${keyRes.error}`);
        await waitForKeypress();
        return null;
    }

    const { keyFile, pubKeyContent } = keyRes;
    writeStatusOK(`Dedicated SSH key generated: ${chalk.yellow(path.basename(keyFile))}`);
    writeStatusOK('Public SSH key COPIED to your clipboard automatically!');

    // Step 3: Instructions to add to GitHub
    console.log();
    writeSectionHeader(`Step 3 of 4: Add SSH Key in GitHub`, 'cyan');
    console.log(chalk.gray('  Public key text (already copied in your clipboard):'));
    console.log(chalk.gray('  ' + '─'.repeat(70)));
    console.log(chalk.cyan(`  ${pubKeyContent}`));
    console.log(chalk.gray('  ' + '─'.repeat(70)));
    console.log();
    console.log(chalk.white('  1. Open:  ') + chalk.cyan('https://github.com/settings/ssh/new'));
    console.log(chalk.gray(`     (Ensure you are logged into GitHub as: ${chalk.bold.yellow(githubUser)})`));
    console.log(chalk.white(`  2. Title: `) + chalk.white(`${os.hostname()} (${name})`));
    console.log(chalk.white(`  3. Key type: `) + chalk.white('Authentication Key'));
    console.log(chalk.white(`  4. Key:   `) + chalk.gray('Click the box and press ') + chalk.white('Ctrl + V') + chalk.gray(' (already copied)'));
    console.log(chalk.white(`  5. Click: `) + chalk.green('Add SSH key'));
    console.log();

    const { openBrowser } = await inquirer.prompt([{
        type: 'confirm',
        name: 'openBrowser',
        message: 'Open GitHub SSH settings in your browser now?',
        default: true
    }]);

    if (openBrowser) {
        openUrl('https://github.com/settings/ssh/new');
    }

    // Step 4: Verification loop
    console.log();
    writeSectionHeader('Step 4 of 4: Test & Verify Connection', 'cyan');
    let authenticated = false;

    while (!authenticated) {
        await inquirer.prompt([{
            type: 'input',
            name: 'ready',
            message: 'Once added in GitHub, press Enter to test connection...'
        }]);

        console.log(chalk.gray('\n  ◈ Testing SSH connection to GitHub...'));
        const testRes = testSSHConnection(keyFile, sshHost);

        if (testRes.success) {
            authenticated = true;
            console.log();
            writeStatusOK(`CONNECTION VERIFIED! Authenticated with GitHub as: ${chalk.bold.green(githubUser)}`);
        } else {
            console.log();
            writeStatusWarn('Connection test did not succeed yet.');
            if (testRes.output) {
                console.log(chalk.gray(`  GitHub response: ${testRes.output}`));
            }
            console.log();

            const { action } = await inquirer.prompt([{
                type: 'list',
                name: 'action',
                message: 'What would you like to do?',
                choices: [
                    { name: '1. Re-test connection', value: 'retry' },
                    { name: '2. Re-copy public key to clipboard', value: 'copy' },
                    { name: '3. Open GitHub SSH page in browser', value: 'open' },
                    { name: '4. Continue anyway and save profile', value: 'skip' }
                ]
            }]);

            if (action === 'copy') {
                copyToClipboard(pubKeyContent);
                writeStatusOK('Key re-copied to clipboard!');
            } else if (action === 'open') {
                openUrl('https://github.com/settings/ssh/new');
            } else if (action === 'skip') {
                break;
            }
        }
    }

    // Optional API Token
    console.log();
    writeSectionHeader('Optional: GitHub Personal Access Token (API)', 'yellow');
    console.log(chalk.gray('  Needed only for automatic repo creation & deletion via API.'));
    console.log(chalk.gray('  Generate at: ') + chalk.cyan('https://github.com/settings/tokens') + chalk.gray(' (Tokens classic: repo, delete_repo)'));
    console.log(chalk.gray('  (Press Enter to skip if you only use Git SSH)\n'));

    const { token } = await inquirer.prompt([{
        type: 'password',
        name: 'token',
        message: `Personal Access Token for ${githubUser} (optional):`,
        mask: '•'
    }]);

    const newProfile = {
        name,
        email,
        github_user: githubUser,
        ssh_host: sshHost,
        ssh_key: keyFile
    };

    if (token && token.trim()) {
        const cleanTok = token.trim();
        newProfile.token = cleanTok;
        const tokens = getTokens();
        tokens[githubUser] = cleanTok;
        saveTokens(tokens);
        writeStatusOK('Personal Access Token saved for this profile!');
    }

    const profiles = getProfiles();
    profiles.push(newProfile);
    saveProfiles(profiles);
    console.log();
    writeStatusOK(`Profile '${name}' saved successfully in ${PROFILES_PATH}!`);
    return newProfile;
}

async function selectProfile() {
    let profiles = getProfiles();
    if (profiles.length === 0) {
        writeStatusWarn(`No GitHub profiles configured in ${PROFILES_PATH}`);
        const { setupNow } = await inquirer.prompt([{
            type: 'confirm',
            name: 'setupNow',
            message: 'Would you like to set up a GitHub profile now?',
            default: true
        }]);
        if (!setupNow) return null;
        const created = await createProfileInteractive();
        if (!created) return null;
        profiles = [created];
    }

    if (profiles.length === 1) {
        return profiles[0];
    }

    console.log();
    const { profile } = await inquirer.prompt([{
        type: 'list',
        name: 'profile',
        message: 'Select GitHub profile:',
        choices: profiles.map(p => {
            const keyPath = p.ssh_key || getProfileSSHKeyPath(p.github_user);
            const keyTag = fs.existsSync(keyPath) ? chalk.green('✓ Key') : chalk.yellow('! No Key');
            return {
                name: `${p.name} (${p.github_user}) [${keyTag}]`,
                value: p
            };
        })
    }]);

    return profile;
}

async function managePreferences() {
    while (true) {
        clearHost();
        writeBanner('GitHub Profiles & Preferences');
        const profiles = getProfiles();
        console.log(chalk.cyan(`  Configured profiles: ${chalk.yellow(profiles.length)}`));
        console.log(chalk.gray(`  Profiles file: ${PROFILES_PATH}\n`));

        const { prefAction } = await inquirer.prompt([{
            type: 'list',
            name: 'prefAction',
            message: 'Preferences:',
            choices: [
                { name: '1. List Profiles', value: 'list' },
                { name: '2. Add New Profile', value: 'add' },
                { name: '3. Edit Profile', value: 'edit' },
                { name: '4. Delete Profile', value: 'delete' },
                { name: '5. Setup / Manage Dedicated SSH Keys', value: 'ssh_key' }
            ]
        }]);

        if (prefAction === 'ssh_key') {
            await handleSSHKeySetup(profiles);
        }

        if (prefAction === 'list') {
            clearHost();
            writeBanner('Configured Profiles', 'cyan');
            if (profiles.length === 0) {
                writeStatusWarn('No profiles configured yet.');
            } else {
                const tokens = getTokens();
                profiles.forEach((p, idx) => {
                    const tok = p.token || tokens[p.github_user];
                    const tokStatus = tok ? chalk.green(`✓ Configured (••••${tok.slice(-4)})`) : chalk.gray('○ None (SSH push only)');
                    const keyPath = p.ssh_key || getProfileSSHKeyPath(p.github_user);
                    const keyExists = fs.existsSync(keyPath);
                    const keyStatus = keyExists ? chalk.green(`✓ Dedicated key (${path.basename(keyPath)})`) : chalk.red('X No key generated');

                    console.log(`  ${chalk.cyan(`[${idx + 1}]`)} ${chalk.bold.yellow(p.name)}`);
                    console.log(`      Username:    ${chalk.green(p.github_user)}`);
                    console.log(`      Email:       ${chalk.gray(p.email || 'Not set')}`);
                    console.log(`      SSH Key:     ${keyStatus}`);
                    console.log(`      API Token:   ${tokStatus}`);
                    console.log();
                });
            }
            await waitForKeypress();
        }

        if (prefAction === 'add') {
            console.log();
            await createProfileInteractive();
        }

        if (prefAction === 'edit') {
            if (profiles.length === 0) {
                writeStatusWarn('No profiles to edit.');
                await waitForKeypress('Press enter...');
                continue;
            }

            clearHost();
            writeBanner('Edit Profile', 'cyan');
            const { targetIndex } = await inquirer.prompt([{
                type: 'list',
                name: 'targetIndex',
                message: 'Select profile to edit:',
                choices: profiles.map((p, i) => ({
                    name: `${p.name} (${p.github_user})`,
                    value: i
                }))
            }]);

            const current = profiles[targetIndex];
            const tokens = getTokens();
            const currentTok = current.token || tokens[current.github_user];
            console.log();
            writeSectionHeader(`Editing: ${current.name}`, 'cyan');

            const edited = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'name',
                    message: 'Profile label:',
                    default: current.name,
                    validate: v => v.trim() ? true : 'Required'
                },
                {
                    type: 'input',
                    name: 'github_user',
                    message: 'GitHub username:',
                    default: current.github_user,
                    validate: v => v.trim() ? true : 'Required'
                },
                {
                    type: 'input',
                    name: 'email',
                    message: 'GitHub email:',
                    default: current.email || '',
                    validate: v => v.trim() ? true : 'Required'
                }
            ]);

            console.log();
            writeSectionHeader('Personal Access Token (API)', 'yellow');
            console.log(chalk.gray(`  Current Token: ${currentTok ? chalk.green(`Configured (••••${currentTok.slice(-4)})`) : chalk.gray('None')}`));
            console.log(chalk.yellow('  Required scopes on GitHub: ') + chalk.white('repo, delete_repo'));
            console.log(chalk.gray('  (Press Enter to keep current, type "none" to remove, or paste new token)\n'));

            const tokenDefault = currentTok ? `••••${currentTok.slice(-4)}` : undefined;
            const { tokenInput } = await inquirer.prompt([{
                type: 'input',
                name: 'tokenInput',
                message: 'Personal Access Token:',
                default: tokenDefault
            }]);

            let finalToken = currentTok || undefined;
            const cleanInput = (tokenInput || '').trim();

            if (cleanInput && cleanInput !== tokenDefault) {
                if (cleanInput.toLowerCase() === 'none') {
                    finalToken = undefined;
                    delete tokens[edited.github_user.trim()];
                    if (edited.github_user.trim() !== current.github_user) {
                        delete tokens[current.github_user];
                    }
                    saveTokens(tokens);
                    writeStatusOK('Token removed.');
                } else {
                    finalToken = cleanInput;
                    tokens[edited.github_user.trim()] = cleanInput;
                    if (edited.github_user.trim() !== current.github_user) {
                        delete tokens[current.github_user];
                    }
                    saveTokens(tokens);
                    writeStatusOK('Token updated.');
                }
            } else if (cleanInput === tokenDefault) {
                if (edited.github_user.trim() !== current.github_user && currentTok) {
                    tokens[edited.github_user.trim()] = currentTok;
                    delete tokens[current.github_user];
                    saveTokens(tokens);
                }
            }

            profiles[targetIndex] = {
                name: edited.name.trim(),
                email: edited.email.trim(),
                github_user: edited.github_user.trim(),
                ssh_host: current.ssh_host || 'github.com',
                ssh_key: current.ssh_key || getProfileSSHKeyPath(edited.github_user.trim()),
                ...(finalToken ? { token: finalToken } : {})
            };

            saveProfiles(profiles);
            writeStatusOK(`Profile '${edited.name}' updated!`);
            await waitForKeypress('Press enter...');
        }

        if (prefAction === 'delete') {
            if (profiles.length === 0) {
                writeStatusWarn('No profiles to delete.');
                await waitForKeypress('Press enter...');
                continue;
            }

            clearHost();
            writeBanner('Delete Profile', 'red');
            const { targetIndex } = await inquirer.prompt([{
                type: 'list',
                name: 'targetIndex',
                message: 'Select profile to delete:',
                choices: profiles.map((p, i) => ({
                    name: `${p.name} (${p.github_user})`,
                    value: i
                }))
            }]);

            const toDelete = profiles[targetIndex];
            const { confirmDel } = await inquirer.prompt([{
                type: 'confirm',
                name: 'confirmDel',
                message: `Are you sure you want to delete '${toDelete.name}' (${toDelete.github_user})?`,
                default: false
            }]);

            if (confirmDel) {
                const tokens = getTokens();
                if (tokens[toDelete.github_user]) {
                    delete tokens[toDelete.github_user];
                    saveTokens(tokens);
                }
                profiles.splice(targetIndex, 1);
                saveProfiles(profiles);
                writeStatusOK('Profile removed.');
            } else {
                writeStatusWarn('Cancelled.');
            }
            await waitForKeypress('Press enter...');
        }
    }
}

module.exports = {
    getProfiles,
    saveProfiles,
    getTokens,
    saveTokens,
    getEnvTokenForUser,
    getToken,
    createProfileInteractive,
    selectProfile,
    managePreferences
};

