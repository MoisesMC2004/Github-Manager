const chalk = require('chalk');
const inquirer = require('inquirer');
const { spawnSync } = require('child_process');
const os = require('os');

function clearHost() {
    process.stdout.write(os.platform() === 'win32' ? '\x1B[2J\x1B[0f' : '\x1B[2J\x1B[3J\x1B[H');
}

function writeBanner(title, color = 'cyan') {
    const padLen = 60;
    const border = '═'.repeat(padLen);
    console.log(chalk[color](`  ╔${border}╗`));
    console.log(chalk[color]('  ║') + chalk.bold.white(`   ${title}`.padEnd(padLen)) + chalk[color]('║'));
    console.log(chalk[color](`  ╚${border}╝`));
    console.log();
}

function writeSectionHeader(title, color = 'cyan') {
    console.log(chalk[color](`  ── ◆ ${title} `) + chalk.gray('─'.repeat(Math.max(10, 48 - title.length))));
}

function writeStatusOK(msg) { console.log(chalk.green(`  ✓ ${msg}`)); }
function writeStatusError(msg) { console.log(chalk.red(`  ✗ ${msg}`)); }
function writeStatusWarn(msg) { console.log(chalk.yellow(`  ! ${msg}`)); }
function writeStatusInfo(msg) { console.log(chalk.cyan(`  ◈ ${msg}`)); }

function getSafeRepoName(name) {
    if (!name) return '';
    return name.replace(/\s+/g, '-').replace(/[^A-Za-z0-9\-_.]/g, '');
}

function copyToClipboard(text) {
    try {
        if (os.platform() === 'win32') {
            try {
                spawnSync('clip', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
                return true;
            } catch {
                spawnSync('powershell.exe', ['-NoProfile', '-Command', '$val = [Console]::In.ReadToEnd(); Set-Clipboard -Value $val'], {
                    input: text,
                    stdio: ['pipe', 'ignore', 'ignore'],
                    windowsHide: true
                });
                return true;
            }
        } else if (os.platform() === 'darwin') {
            spawnSync('pbcopy', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
            return true;
        } else {
            const xclipRes = spawnSync('xclip', ['-selection', 'clipboard'], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
            if (xclipRes.status === 0) return true;
            const wlRes = spawnSync('wl-copy', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
            return wlRes.status === 0;
        }
    } catch {
        return false;
    }
}

function openUrl(url) {
    try {
        if (os.platform() === 'win32') {
            spawnSync('cmd.exe', ['/c', 'start', '""', url], { stdio: 'ignore', windowsHide: true });
        } else if (os.platform() === 'darwin') {
            spawnSync('open', [url], { stdio: 'ignore' });
        } else {
            spawnSync('xdg-open', [url], { stdio: 'ignore' });
        }
    } catch {}
}

async function waitForKeypress(message = 'Press enter to return...') {
    try {
        await inquirer.prompt([{ type: 'input', name: 'w', message }]);
    } catch {}
}

module.exports = {
    clearHost,
    writeBanner,
    writeSectionHeader,
    writeStatusOK,
    writeStatusError,
    writeStatusWarn,
    writeStatusInfo,
    getSafeRepoName,
    waitForKeypress,
    copyToClipboard,
    openUrl
};

