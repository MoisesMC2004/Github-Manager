const path = require('path');
const fs = require('fs-extra');
const chalk = require('chalk');
const { spawnSync } = require('child_process');
const os = require('os');
const inquirer = require('inquirer');
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

const binaryCache = new Map();

function findSystemBinary(name) {
    if (binaryCache.has(name)) {
        return binaryCache.get(name);
    }

    try {
        const check = spawnSync(name, ['-V'], { stdio: 'ignore', windowsHide: true });
        if (check.status === 0 || check.status === 1) {
            binaryCache.set(name, name);
            return name;
        }
    } catch {}

    if (os.platform() === 'win32') {
        const exeName = `${name}.exe`;
        const candidates = [
            path.join('C:\\Program Files\\Git\\usr\\bin', exeName),
            path.join('C:\\Windows\\System32\\OpenSSH', exeName),
            path.join('C:\\Program Files (x86)\\Git\\usr\\bin', exeName),
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'usr', 'bin', exeName)
        ];

        try {
            const gitRes = spawnSync('where', ['git'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
            if (gitRes.status === 0 && gitRes.stdout) {
                const gitPath = gitRes.stdout.toString().trim().split(/\r?\n/)[0];
                if (gitPath) {
                    const gitDir = path.dirname(gitPath);
                    candidates.push(path.resolve(gitDir, '..', 'usr', 'bin', exeName));
                    candidates.push(path.resolve(gitDir, '..', 'bin', exeName));
                }
            }
        } catch {}

        for (const c of candidates) {
            if (fs.existsSync(c)) {
                binaryCache.set(name, c);
                return c;
            }
        }
    }

    const fallback = name === 'ssh' ? 'ssh' : null;
    binaryCache.set(name, fallback);
    return fallback;
}

function getSSHBinary() {
    return findSystemBinary('ssh') || 'ssh';
}

function getSSHKeygenBinary() {
    return findSystemBinary('ssh-keygen');
}

function getProfileSSHKeyPath(githubUser) {
    const safeUser = (githubUser || 'user').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const sshDir = path.join(os.homedir(), '.ssh');
    return path.join(sshDir, `id_ed25519_${safeUser}`);
}

function getProfileSSHCommand(profile) {
    const sshBin = getSSHBinary();
    const keyPath = profile.ssh_key || getProfileSSHKeyPath(profile.github_user);
    if (fs.existsSync(keyPath)) {
        return `"${sshBin}" -i "${keyPath.replace(/\\/g, '/')}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10`;
    }
    return `"${sshBin}" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10`;
}

function testSSHConnection(sshKeyPath, sshHost = 'github.com') {
    const sshBin = getSSHBinary();
    const args = [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=8',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'IdentitiesOnly=yes',
        '-T',
        `git@${sshHost}`
    ];
    if (sshKeyPath && fs.existsSync(sshKeyPath)) {
        args.unshift('-i', sshKeyPath);
    }

    try {
        const res = spawnSync(sshBin, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });

        const output = ((res.stdout ? res.stdout.toString() : '') + ' ' + (res.stderr ? res.stderr.toString() : '')).trim();
        const success = /successfully authenticated/i.test(output) || /Hi\s+[^!]+/i.test(output);
        return { success, output };
    } catch (e) {
        return { success: false, output: e.message };
    }
}

function generateDedicatedSSHKey(githubUser, email = '') {
    const keygenBin = getSSHKeygenBinary();
    if (!keygenBin) {
        return {
            success: false,
            error: 'Could not find ssh-keygen on your system. Ensure OpenSSH is installed.'
        };
    }

    const keyFile = getProfileSSHKeyPath(githubUser);
    const pubKeyFile = `${keyFile}.pub`;
    const sshDir = path.dirname(keyFile);

    try {
        fs.ensureDirSync(sshDir);
        try { fs.chmodSync(sshDir, 0o700); } catch {}

        if (fs.existsSync(keyFile)) {
            try { fs.removeSync(keyFile); } catch {}
        }
        if (fs.existsSync(pubKeyFile)) {
            try { fs.removeSync(pubKeyFile); } catch {}
        }

        const comment = (email && email.trim()) || `${githubUser}@github-manager`;
        const res = spawnSync(keygenBin, ['-t', 'ed25519', '-C', comment, '-f', keyFile, '-N', ''], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });

        if (res.status !== 0) {
            const errMsg = res.stderr ? res.stderr.toString().trim() : (res.error ? res.error.message : 'Unknown error');
            return { success: false, error: errMsg };
        }

        try { fs.chmodSync(keyFile, 0o600); } catch {}
        try { fs.chmodSync(pubKeyFile, 0o644); } catch {}

        const pubKeyContent = fs.readFileSync(pubKeyFile, 'utf8').trim();
        copyToClipboard(pubKeyContent);

        return {
            success: true,
            keyFile,
            pubKeyFile,
            pubKeyContent
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function handleSSHKeySetup(profiles = []) {
    clearHost();
    writeBanner('SSH Key Management', 'cyan');

    if (!profiles || profiles.length === 0) {
        writeStatusWarn('No profiles found. Create a profile first to set up its dedicated SSH key.');
        await waitForKeypress();
        return;
    }

    const { selectedProfile } = await inquirer.prompt([{
        type: 'list',
        name: 'selectedProfile',
        message: 'Select profile to manage SSH key:',
        choices: profiles.map(p => ({
            name: `${p.name} (User: ${p.github_user})`,
            value: p
        }))
    }]);

    const keyPath = selectedProfile.ssh_key || getProfileSSHKeyPath(selectedProfile.github_user);
    const pubKeyPath = `${keyPath}.pub`;
    const keyExists = fs.existsSync(pubKeyPath);

    console.log();
    writeSectionHeader(`SSH Key: ${selectedProfile.github_user}`, 'cyan');
    console.log(`  ◈ Key file:   ${chalk.yellow(path.basename(keyPath))}`);
    console.log(`  ◈ Full path:  ${chalk.gray(keyPath)}`);
    console.log(`  ◈ Status:     ${keyExists ? chalk.green('✓ Key exists on disk') : chalk.red('X Key not generated yet')}\n`);

    if (keyExists) {
        const pubKeyContent = fs.readFileSync(pubKeyPath, 'utf8').trim();
        console.log(chalk.gray('  Public key text:'));
        console.log(chalk.gray('  ' + '─'.repeat(70)));
        console.log(chalk.cyan(`  ${pubKeyContent}`));
        console.log(chalk.gray('  ' + '─'.repeat(70)));
        console.log();
    }

    const { keyAction } = await inquirer.prompt([{
        type: 'list',
        name: 'keyAction',
        message: 'Select action:',
        choices: [
            { name: '1. Test SSH Connection to GitHub', value: 'test' },
            { name: '2. Copy Public Key to Clipboard', value: 'copy' },
            { name: '3. Open GitHub SSH Settings in Browser', value: 'open' },
            { name: '4. Re-generate Dedicated Key for this Profile', value: 'regen' }
        ]
    }]);

    if (keyAction === 'test') {
        if (!keyExists) {
            writeStatusError('SSH key not generated yet. Choose Re-generate to create it.');
        } else {
            console.log(chalk.gray('\n  ◈ Testing SSH connection to GitHub...'));
            const res = testSSHConnection(keyPath, selectedProfile.ssh_host || 'github.com');
            if (res.success) {
                console.log();
                writeStatusOK(`CONNECTION VERIFIED! Authenticated with GitHub as: ${chalk.bold.green(selectedProfile.github_user)}`);
            } else {
                console.log();
                writeStatusError('Authentication failed.');
                if (res.output) console.log(chalk.gray(`  GitHub response: ${res.output}`));
                console.log(chalk.yellow(`  Ensure you have added this public key to: https://github.com/settings/ssh/new`));
            }
        }
    }

    if (keyAction === 'copy') {
        if (!keyExists) {
            writeStatusError('SSH key not generated yet.');
        } else {
            const pubKeyContent = fs.readFileSync(pubKeyPath, 'utf8').trim();
            copyToClipboard(pubKeyContent);
            console.log();
            writeStatusOK('Public SSH key COPIED to your clipboard!');
            console.log(chalk.gray('  Paste it in: ') + chalk.cyan('https://github.com/settings/ssh/new'));
        }
    }

    if (keyAction === 'open') {
        openUrl('https://github.com/settings/ssh/new');
        writeStatusOK('Opened https://github.com/settings/ssh/new in browser.');
    }

    if (keyAction === 'regen') {
        const res = generateDedicatedSSHKey(selectedProfile.github_user, selectedProfile.email || 'github-key');
        if (res.success) {
            console.log();
            writeStatusOK(`New dedicated SSH key generated for ${selectedProfile.github_user}!`);
            writeStatusOK('Public key COPIED to your clipboard!');
            console.log(chalk.gray('  Public key text:'));
            console.log(chalk.gray('  ' + '─'.repeat(70)));
            console.log(chalk.cyan(`  ${res.pubKeyContent}`));
            console.log(chalk.gray('  ' + '─'.repeat(70)));
            console.log(chalk.gray('  Add it in: ') + chalk.cyan('https://github.com/settings/ssh/new'));
        } else {
            writeStatusError(`Failed to generate SSH key: ${res.error}`);
        }
    }

    await waitForKeypress();
}

module.exports = {
    getProfileSSHKeyPath,
    getSSHBinary,
    getSSHKeygenBinary,
    getProfileSSHCommand,
    testSSHConnection,
    generateDedicatedSSHKey,
    handleSSHKeySetup
};
